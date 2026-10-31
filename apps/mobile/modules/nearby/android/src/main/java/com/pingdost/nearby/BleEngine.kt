package com.pingdost.nearby

import android.Manifest
import android.annotation.SuppressLint
import android.app.ActivityManager
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothGatt
import android.bluetooth.BluetoothGattCallback
import android.bluetooth.BluetoothGattCharacteristic
import android.bluetooth.BluetoothGattDescriptor
import android.bluetooth.BluetoothGattServer
import android.bluetooth.BluetoothGattServerCallback
import android.bluetooth.BluetoothGattService
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothProfile
import android.bluetooth.BluetoothStatusCodes
import android.bluetooth.le.AdvertiseData
import android.bluetooth.le.AdvertisingSet
import android.bluetooth.le.AdvertisingSetCallback
import android.bluetooth.le.AdvertisingSetParameters
import android.bluetooth.le.ScanCallback
import android.bluetooth.le.ScanFilter
import android.bluetooth.le.ScanResult
import android.bluetooth.le.ScanSettings
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.os.BatteryManager
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.os.ParcelUuid
import android.os.PowerManager
import android.os.SystemClock
import android.util.Log
import java.security.SecureRandom
import java.util.UUID

typealias Reply = (result: Any?, error: String?) -> Unit

/** What `start` asks for. Equal configs do not restart the radios. */
data class StartConfig(
  val scanMode: Int = ScanSettings.SCAN_MODE_LOW_LATENCY,
  val advertiseInterval: Int = AdvertisingSetParameters.INTERVAL_LOW,
  val txPower: Int = AdvertisingSetParameters.TX_POWER_MEDIUM,
  val rotationMs: Long = 10 * 60_000L,
  val autoConnect: Boolean = false,
  val advertise: Boolean = true,
  val scan: Boolean = true,
)

/**
 * The BLE side of nearby (Phase 21, ADR 0023): one GATT service that every PingDost phone both
 * serves and connects to, legacy advertising with a rotating random token (no static
 * identifier), filtered scanning, and [Link]s over GATT writes (central → peripheral) and
 * notifications (peripheral → central).
 *
 * Everything runs on one handler thread; Bluetooth callbacks are posted onto it. The engine is
 * a process singleton, so links and queued packets outlive a JS reload. Nothing here logs
 * packet contents; the `log` event carries only states and sizes.
 */
@SuppressLint("MissingPermission") // every entry point checks permissions; SecurityException is caught
object BleEngine {
  val SERVICE_UUID: UUID = UUID.fromString("5dd57eaf-834a-4b2d-96f6-b68a646c4a0b")
  val RX_UUID: UUID = UUID.fromString("aa6298cf-710a-43a7-a85e-42eae340dc5a")
  val TX_UUID: UUID = UUID.fromString("5a378fa3-6ee8-409f-bcd4-99790bc7feec")
  private val CCCD_UUID: UUID = UUID.fromString("00002902-0000-1000-8000-00805f9b34fb")
  private val SERVICE = ParcelUuid(SERVICE_UUID)

  private const val TAG = "PingdostNearby"
  const val MAX_LINKS = 7
  private const val CONNECT_TIMEOUT_MS = 20_000L
  private const val PEER_TTL_MS = 30_000L
  private const val PEER_REPORT_MS = 2_000L
  private const val WATCH_MS = 5_000L
  private const val AUTO_CONNECT_BACKOFF_MS = 10_000L
  private const val WRITE_RETRY_MS = 10L
  private const val WRITE_RETRIES = 100

  private val thread = HandlerThread("pingdost-nearby").apply { start() }
  private val handler = Handler(thread.looper)
  private val random = SecureRandom()

  /** Set by the Expo module; events go to JS. */
  @Volatile var emitter: ((String, Map<String, Any?>) -> Unit)? = null

  private var context: Context? = null
  private var manager: BluetoothManager? = null
  private val adapter: BluetoothAdapter?
    get() = manager?.adapter

  private var config = StartConfig()
  private var wanted = false
  private var advertising = false
  private var scanning = false
  private var lastEnabled: Boolean? = null
  private var foreground = false
  private var token = newToken()
  private var advCallback: AdvCallback? = null
  private var server: BluetoothGattServer? = null
  private var serverTx: BluetoothGattCharacteristic? = null

  private class Peer(var device: BluetoothDevice, val firstSeen: Long) {
    var token: ByteArray? = null
    var rssi = 0
    var lastSeen = firstSeen
    var lastReport = 0L
  }

  private enum class Stage { CONNECTING, MTU, DISCOVERING, SUBSCRIBING, READY }

  private class Central(val gatt: BluetoothGatt) {
    var stage = Stage.CONNECTING
    var rx: BluetoothGattCharacteristic? = null
  }

  private val peers = HashMap<String, Peer>()
  private val links = HashMap<Int, Link>()
  private val centrals = HashMap<Int, Central>()
  private val peripheralDevices = HashMap<Int, BluetoothDevice>()
  private val serverLinks = HashMap<String, Int>()
  private val serverMtu = HashMap<String, Int>()
  private val pendingConnects = HashMap<Int, (Map<String, Any?>?, String?) -> Unit>()
  private val autoConnectTried = HashMap<String, Long>()
  private var nextLinkId = 1

  private val inboundLock = Any()
  private val inbound = ArrayDeque<Pair<Int, ByteArray>>()
  private var inboundNotified = false

  // ---- Public API (called from the Expo module on any thread) -------------------------------

  fun attach(appContext: Context) = post {
    if (context != null) return@post
    context = appContext
    manager = appContext.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager
    val filter = IntentFilter(BluetoothAdapter.ACTION_STATE_CHANGED)
    if (Build.VERSION.SDK_INT >= 33) {
      appContext.registerReceiver(stateReceiver, filter, Context.RECEIVER_NOT_EXPORTED)
    } else {
      appContext.registerReceiver(stateReceiver, filter)
    }
  }

  fun state(reply: Reply) = request(reply) { reply(stateMap(), null) }

  fun start(next: StartConfig, reply: Reply) = request(reply) {
    unsupportedReason()?.let { return@request reply(null, it) }
    if (missingPermissions().isNotEmpty()) return@request reply(null, "permission")
    val restart = wanted && next != config
    config = next
    wanted = true
    if (restart) stopRadios()
    if (adapter?.isEnabled == true) bringUp() else log("Bluetooth is off: nearby starts when it is turned on")
    handler.removeCallbacks(watchTask)
    handler.postDelayed(watchTask, WATCH_MS)
    emitState()
    reply(null, null)
  }

  fun stop(reply: Reply) = request(reply) {
    wanted = false
    handler.removeCallbacks(watchTask)
    tearDown("stopped")
    emitState()
    reply(null, null)
  }

  fun rotateToken(reply: Reply) = request(reply) {
    rotate()
    reply(hex(token), null)
  }

  fun connect(address: String, reply: Reply) = request(reply) {
    openCentral(address) { info, error -> reply(info, error) }
  }

  fun disconnect(linkId: Int, reply: Reply) = request(reply) {
    links[linkId]?.let { failLink(it, "closed") }
    reply(null, null)
  }

  /** Resolves once the packet is in the link's native queue (not when it is delivered). */
  fun send(linkId: Int, packet: ByteArray, reply: Reply) = request(reply) {
    val link = links[linkId] ?: return@request reply(null, "link_down")
    link.send(packet) { error -> reply(null, error) }
  }

  /**
   * Takes queued inbound packets, oldest first, up to [maxBytes] (at least one): repeated
   * `linkId u32 | length u32 | bytes`. Empty when nothing is queued. While packets remain, no
   * new `packet` event fires: callers loop until an empty batch.
   */
  fun receive(maxBytes: Int): ByteArray {
    val taken = ArrayList<Pair<Int, ByteArray>>()
    var total = 0
    synchronized(inboundLock) {
      while (inbound.isNotEmpty()) {
        val size = 8 + inbound.first().second.size
        if (taken.isNotEmpty() && total + size > maxBytes) break
        taken.add(inbound.removeFirst())
        total += size
      }
      if (inbound.isEmpty()) inboundNotified = false
    }
    if (taken.isEmpty()) return ByteArray(0)
    val counts = taken.groupingBy { it.first }.eachCount()
    post { counts.forEach { (id, count) -> links[id]?.returnCredits(count) } }
    val out = ByteArray(total)
    var at = 0
    for ((id, data) in taken) {
      Frames.putInt(out, at, id)
      Frames.putInt(out, at + 4, data.size)
      System.arraycopy(data, 0, out, at + 8, data.size)
      at += 8 + data.size
    }
    return out
  }

  fun startForegroundService(reply: Reply) = request(reply) {
    val ctx = context ?: return@request reply(null, "not_attached")
    if (missingPermissions().isNotEmpty()) return@request reply(null, "permission")
    try {
      ctx.startForegroundService(Intent(ctx, NearbyService::class.java))
      reply(null, null)
    } catch (error: IllegalStateException) {
      // ForegroundServiceStartNotAllowedException (Android 12+): the app is in the background.
      reply(null, "not_allowed")
    }
  }

  fun stopForegroundService(reply: Reply) = request(reply) {
    val ctx = context ?: return@request reply(null, "not_attached")
    ctx.stopService(Intent(ctx, NearbyService::class.java))
    reply(null, null)
  }

  /** Called by [NearbyService] on the main thread. */
  fun onServiceState(running: Boolean) = post {
    foreground = running
    log(if (running) "foreground service on" else "foreground service off")
    emitState()
  }

  // ---- Radios --------------------------------------------------------------------------------

  private fun bringUp() {
    if (config.advertise) openServer()
    if (config.scan) startScan()
  }

  private fun stopRadios() {
    stopScan()
    stopAdvertising()
  }

  private fun tearDown(reason: String) {
    stopRadios()
    links.values.toList().forEach { failLink(it, reason) }
    closeServer()
    peers.clear()
  }

  private fun openServer() {
    if (server != null) return
    val ctx = context ?: return
    val gattServer = manager?.openGattServer(ctx, ServerCallback)
      ?: return log("could not open the GATT server")
    val service = BluetoothGattService(SERVICE_UUID, BluetoothGattService.SERVICE_TYPE_PRIMARY)
    val rx = BluetoothGattCharacteristic(
      RX_UUID,
      BluetoothGattCharacteristic.PROPERTY_WRITE or BluetoothGattCharacteristic.PROPERTY_WRITE_NO_RESPONSE,
      BluetoothGattCharacteristic.PERMISSION_WRITE,
    )
    val tx = BluetoothGattCharacteristic(TX_UUID, BluetoothGattCharacteristic.PROPERTY_NOTIFY, 0)
    tx.addDescriptor(
      BluetoothGattDescriptor(
        CCCD_UUID,
        BluetoothGattDescriptor.PERMISSION_READ or BluetoothGattDescriptor.PERMISSION_WRITE,
      ),
    )
    service.addCharacteristic(rx)
    service.addCharacteristic(tx)
    server = gattServer
    serverTx = tx
    // Advertising starts once the service is added (onServiceAdded).
    if (!gattServer.addService(service)) log("could not add the GATT service")
  }

  private fun serviceAdded(status: Int) {
    if (status != BluetoothGatt.GATT_SUCCESS) return log("GATT service not added (status $status)")
    if (wanted && config.advertise) startAdvertising()
  }

  private fun closeServer() {
    try {
      server?.close()
    } catch (_: Exception) {
    }
    server = null
    serverTx = null
    serverLinks.clear()
    serverMtu.clear()
  }

  private class AdvCallback : AdvertisingSetCallback() {
    override fun onAdvertisingSetStarted(set: AdvertisingSet?, txPower: Int, status: Int) = guard {
      if (this !== advCallback) {
        // Replaced while starting (token rotation, stop): stop this one.
        try {
          adapter?.bluetoothLeAdvertiser?.stopAdvertisingSet(this)
        } catch (_: Exception) {
        }
        return@guard
      }
      advertising = status == AdvertisingSetCallback.ADVERTISE_SUCCESS
      log(if (advertising) "advertising (tx $txPower dBm)" else "advertising failed (status $status)")
      emitState()
    }
  }

  private fun startAdvertising() {
    if (advCallback != null) return
    val advertiser = adapter?.bluetoothLeAdvertiser ?: return log("this phone cannot advertise over BLE")
    val params = AdvertisingSetParameters.Builder()
      .setLegacyMode(true)
      .setConnectable(true)
      .setScannable(true)
      .setInterval(config.advertiseInterval)
      .setTxPowerLevel(config.txPower)
      .build()
    // Advert: flags + the 128-bit service UUID (21 of 31 bytes; iOS can match it too).
    val data = AdvertiseData.Builder()
      .addServiceUuid(SERVICE)
      .setIncludeDeviceName(false)
      .setIncludeTxPowerLevel(false)
      .build()
    // Scan response: the rotating token as service data (26 of 31 bytes).
    val response = AdvertiseData.Builder()
      .addServiceData(SERVICE, token)
      .setIncludeDeviceName(false)
      .setIncludeTxPowerLevel(false)
      .build()
    val callback = AdvCallback()
    advCallback = callback
    advertiser.startAdvertisingSet(params, data, response, null, null, callback, handler)
    handler.removeCallbacks(rotateTask)
    handler.postDelayed(rotateTask, config.rotationMs)
  }

  private fun stopAdvertising() {
    handler.removeCallbacks(rotateTask)
    val callback = advCallback ?: return
    advCallback = null
    advertising = false
    try {
      adapter?.bluetoothLeAdvertiser?.stopAdvertisingSet(callback)
    } catch (_: Exception) {
    }
  }

  private val rotateTask = Runnable { guard { rotate() } }

  /** A new random token; a new advertising set usually gets a new random address too. */
  private fun rotate() {
    token = newToken()
    if (advCallback != null) {
      stopAdvertising()
      startAdvertising()
    }
    links.values.forEach { it.announceToken(token) }
    log("rotated the advertised token")
    emitState()
  }

  private val scanCallback = object : ScanCallback() {
    override fun onScanResult(callbackType: Int, result: ScanResult) = post { onScan(result) }

    override fun onBatchScanResults(results: MutableList<ScanResult>) = post { results.forEach { onScan(it) } }

    override fun onScanFailed(errorCode: Int) = post {
      scanning = false
      log("scan failed (error $errorCode)")
      emitState()
    }
  }

  private fun startScan() {
    if (scanning) return
    val scanner = adapter?.bluetoothLeScanner ?: return log("BLE scanner unavailable")
    // A non-empty filter: Android stops unfiltered scans while the screen is off.
    val filters = listOf(ScanFilter.Builder().setServiceUuid(SERVICE).build())
    val settings = ScanSettings.Builder()
      .setScanMode(config.scanMode)
      .setCallbackType(ScanSettings.CALLBACK_TYPE_ALL_MATCHES)
      .setMatchMode(ScanSettings.MATCH_MODE_AGGRESSIVE)
      .setNumOfMatches(ScanSettings.MATCH_NUM_MAX_ADVERTISEMENT)
      .setReportDelay(0)
      .build()
    scanner.startScan(filters, settings, scanCallback)
    scanning = true
    log("scanning (mode ${config.scanMode})")
  }

  private fun stopScan() {
    if (!scanning) return
    scanning = false
    try {
      adapter?.bluetoothLeScanner?.stopScan(scanCallback)
    } catch (_: Exception) {
    }
  }

  private fun onScan(result: ScanResult) {
    if (!scanning) return
    val device = result.device
    val address = device.address
    val advertised = result.scanRecord?.getServiceData(SERVICE)?.takeIf { it.size == Frames.TOKEN_BYTES }
    val now = SystemClock.elapsedRealtime()
    val known = peers[address]
    val peer = known ?: Peer(device, now).also { peers[address] = it }
    val tokenChanged = advertised != null && peer.token?.contentEquals(advertised) != true
    if (advertised != null) peer.token = advertised
    peer.device = device
    peer.rssi = result.rssi
    peer.lastSeen = now
    if (known == null || tokenChanged || now - peer.lastReport >= PEER_REPORT_MS) {
      peer.lastReport = now
      emit("peerDiscovered", peerMap(address, peer) + ("first" to (known == null)))
    }
    if (config.autoConnect && advertised != null) maybeAutoConnect(address, advertised, now)
  }

  /** The side with the lower token connects, so two phones open one link, not two. */
  private fun maybeAutoConnect(address: String, peerToken: ByteArray, now: Long) {
    if (compareTokens(token, peerToken) >= 0) return
    if (links.size >= MAX_LINKS) return
    if (links.values.any { it.address == address || it.knowsToken(peerToken) }) return
    val tried = autoConnectTried[address]
    if (tried != null && now - tried < AUTO_CONNECT_BACKOFF_MS) return
    autoConnectTried[address] = now
    log("auto-connecting to $address")
    openCentral(address) { _, error -> if (error != null) log("auto-connect to $address failed: $error") }
  }

  private val watchTask: Runnable = object : Runnable {
    override fun run() {
      guard { watch() }
      if (wanted) handler.postDelayed(this, WATCH_MS)
    }
  }

  /** Expires peers, and catches a Bluetooth state change the broadcast missed. */
  private fun watch() {
    val now = SystemClock.elapsedRealtime()
    val gone = peers.filterValues { now - it.lastSeen > PEER_TTL_MS }.keys.toList()
    gone.forEach {
      peers.remove(it)
      emit("peerLost", mapOf("address" to it))
    }
    autoConnectTried.entries.removeAll { now - it.value > PEER_TTL_MS }
    val enabled = adapter?.isEnabled == true
    if (lastEnabled != null && lastEnabled != enabled) {
      bluetoothState(if (enabled) BluetoothAdapter.STATE_ON else BluetoothAdapter.STATE_OFF)
    }
    lastEnabled = enabled
  }

  private val stateReceiver = object : BroadcastReceiver() {
    override fun onReceive(ctx: Context, intent: Intent) {
      val state = intent.getIntExtra(BluetoothAdapter.EXTRA_STATE, BluetoothAdapter.ERROR)
      post { bluetoothState(state) }
    }
  }

  private fun bluetoothState(state: Int) {
    when (state) {
      BluetoothAdapter.STATE_TURNING_OFF, BluetoothAdapter.STATE_OFF -> {
        if (lastEnabled == false && server == null && links.isEmpty()) return
        lastEnabled = false
        scanning = false
        advertising = false
        advCallback = null
        handler.removeCallbacks(rotateTask)
        links.values.toList().forEach { failLink(it, "bluetooth_off") }
        closeServer()
        peers.clear()
        log("Bluetooth is off")
      }
      BluetoothAdapter.STATE_ON -> {
        if (lastEnabled == true && (scanning || server != null)) return
        lastEnabled = true
        log("Bluetooth is on")
        if (wanted) bringUp()
      }
      else -> return
    }
    emitState()
  }

  // ---- Central role (we connect) -------------------------------------------------------------

  private fun openCentral(address: String, done: (Map<String, Any?>?, String?) -> Unit) {
    val ctx = context ?: return done(null, "not_attached")
    unsupportedReason()?.let { return done(null, it) }
    val bt = adapter ?: return done(null, "no_bluetooth")
    if (!bt.isEnabled) return done(null, "bluetooth_off")
    if (missingPermissions().isNotEmpty()) return done(null, "permission")
    if (links.size >= MAX_LINKS) return done(null, "too_many_links")
    links.values.firstOrNull { it.role == Role.CENTRAL && it.address == address }?.let { existing ->
      return if (existing.up) done(linkMap(existing), null) else done(null, "connecting")
    }
    val device = peers[address]?.device ?: bt.getRemoteDevice(address)
    val id = nextLinkId++
    val link = Link(id, Role.CENTRAL, address, token.copyOf(), { frame -> centralWrite(id, frame) }, Listener)
    links[id] = link
    pendingConnects[id] = done
    val gatt = device.connectGatt(
      ctx,
      false,
      GattClient(id),
      BluetoothDevice.TRANSPORT_LE,
      BluetoothDevice.PHY_LE_1M_MASK or BluetoothDevice.PHY_LE_2M_MASK,
      handler,
    ) ?: return failLink(link, "connect refused")
    centrals[id] = Central(gatt)
    log("link $id: connecting to $address")
    handler.postDelayed({ guard { if (!link.closed && !link.up) failLink(link, "timeout") } }, CONNECT_TIMEOUT_MS)
  }

  private class GattClient(private val id: Int) : BluetoothGattCallback() {
    override fun onConnectionStateChange(gatt: BluetoothGatt, status: Int, newState: Int) =
      post { clientState(id, gatt, status, newState) }

    override fun onMtuChanged(gatt: BluetoothGatt, mtu: Int, status: Int) = post { clientMtu(id, mtu, status) }

    override fun onServicesDiscovered(gatt: BluetoothGatt, status: Int) = post { clientServices(id, status) }

    override fun onDescriptorWrite(gatt: BluetoothGatt, descriptor: BluetoothGattDescriptor, status: Int) =
      post { clientSubscribed(id, status) }

    override fun onCharacteristicWrite(
      gatt: BluetoothGatt,
      characteristic: BluetoothGattCharacteristic,
      status: Int,
    ) = post { links[id]?.onWriteComplete(status == BluetoothGatt.GATT_SUCCESS) }

    override fun onCharacteristicChanged(
      gatt: BluetoothGatt,
      characteristic: BluetoothGattCharacteristic,
      value: ByteArray,
    ) {
      if (characteristic.uuid != TX_UUID) return
      val frame = value.copyOf()
      post { links[id]?.onFrame(frame) }
    }

    @Deprecated("Android 12 and older deliver notifications here")
    @Suppress("DEPRECATION")
    override fun onCharacteristicChanged(gatt: BluetoothGatt, characteristic: BluetoothGattCharacteristic) {
      if (Build.VERSION.SDK_INT >= 33 || characteristic.uuid != TX_UUID) return
      // The characteristic object is reused for the next notification: copy now.
      val frame = characteristic.value?.copyOf() ?: return
      post { links[id]?.onFrame(frame) }
    }

    override fun onPhyUpdate(gatt: BluetoothGatt, txPhy: Int, rxPhy: Int, status: Int) = post {
      links[id]?.let {
        it.txPhy = txPhy
        it.rxPhy = rxPhy
        log("link $id: PHY tx $txPhy rx $rxPhy")
      }
    }
  }

  private fun clientState(id: Int, gatt: BluetoothGatt, status: Int, newState: Int) {
    val link = links[id]
    val central = centrals[id]
    if (link == null || central == null) {
      gatt.close()
      return
    }
    if (newState == BluetoothProfile.STATE_CONNECTED && status == BluetoothGatt.GATT_SUCCESS) {
      if (central.stage != Stage.CONNECTING) return
      central.stage = Stage.MTU
      gatt.requestConnectionPriority(BluetoothGatt.CONNECTION_PRIORITY_HIGH)
      log("link $id: connected, asking for MTU ${Frames.REQUESTED_MTU}")
      if (!gatt.requestMtu(Frames.REQUESTED_MTU)) discover(id, central)
    } else if (newState == BluetoothProfile.STATE_DISCONNECTED || status != BluetoothGatt.GATT_SUCCESS) {
      failLink(link, if (status == BluetoothGatt.GATT_SUCCESS) "disconnected" else "disconnected (status $status)")
    }
  }

  private fun clientMtu(id: Int, mtu: Int, status: Int) {
    val link = links[id] ?: return
    if (status == BluetoothGatt.GATT_SUCCESS) link.mtu = mtu
    log("link $id: MTU ${link.mtu}")
    val central = centrals[id] ?: return
    if (central.stage == Stage.MTU) discover(id, central)
  }

  private fun discover(id: Int, central: Central) {
    central.stage = Stage.DISCOVERING
    if (!central.gatt.discoverServices()) links[id]?.let { failLink(it, "service discovery refused") }
  }

  private fun clientServices(id: Int, status: Int) {
    val link = links[id] ?: return
    val central = centrals[id] ?: return
    if (central.stage != Stage.DISCOVERING) return
    if (status != BluetoothGatt.GATT_SUCCESS) return failLink(link, "service discovery failed ($status)")
    val service = central.gatt.getService(SERVICE_UUID) ?: return failLink(link, "not a PingDost peer")
    val rx = service.getCharacteristic(RX_UUID)
    val tx = service.getCharacteristic(TX_UUID)
    val cccd = tx?.getDescriptor(CCCD_UUID)
    if (rx == null || tx == null || cccd == null) return failLink(link, "PingDost service incomplete")
    central.rx = rx
    central.stage = Stage.SUBSCRIBING
    central.gatt.setCharacteristicNotification(tx, true)
    if (!writeCccd(central.gatt, cccd)) failLink(link, "subscribe refused")
  }

  @Suppress("DEPRECATION") // the pre-Android 13 path
  private fun writeCccd(gatt: BluetoothGatt, cccd: BluetoothGattDescriptor): Boolean {
    val enable = BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE
    if (Build.VERSION.SDK_INT >= 33) return gatt.writeDescriptor(cccd, enable) == BluetoothStatusCodes.SUCCESS
    cccd.value = enable
    return gatt.writeDescriptor(cccd)
  }

  @Suppress("DEPRECATION") // the pre-Android 13 path
  private fun writeRx(gatt: BluetoothGatt, rx: BluetoothGattCharacteristic, frame: ByteArray): Boolean {
    val type = BluetoothGattCharacteristic.WRITE_TYPE_NO_RESPONSE
    if (Build.VERSION.SDK_INT >= 33) return gatt.writeCharacteristic(rx, frame, type) == BluetoothStatusCodes.SUCCESS
    rx.writeType = type
    rx.value = frame
    return gatt.writeCharacteristic(rx)
  }

  @Suppress("DEPRECATION") // the pre-Android 13 path
  private fun notifyTx(
    gattServer: BluetoothGattServer,
    device: BluetoothDevice,
    tx: BluetoothGattCharacteristic,
    frame: ByteArray,
  ): Boolean {
    if (Build.VERSION.SDK_INT >= 33) {
      return gattServer.notifyCharacteristicChanged(device, tx, false, frame) == BluetoothStatusCodes.SUCCESS
    }
    tx.value = frame
    return gattServer.notifyCharacteristicChanged(device, tx, false)
  }

  private fun clientSubscribed(id: Int, status: Int) {
    val link = links[id] ?: return
    val central = centrals[id] ?: return
    if (central.stage != Stage.SUBSCRIBING) return
    if (status != BluetoothGatt.GATT_SUCCESS) return failLink(link, "subscribe failed ($status)")
    central.stage = Stage.READY
    if (adapter?.isLe2MPhySupported == true) {
      central.gatt.setPreferredPhy(
        BluetoothDevice.PHY_LE_2M_MASK,
        BluetoothDevice.PHY_LE_2M_MASK,
        BluetoothDevice.PHY_OPTION_NO_PREFERRED,
      )
    }
    link.start()
    maybeUp(link)
  }

  private fun centralWrite(id: Int, frame: ByteArray): Boolean {
    val central = centrals[id] ?: return false
    val rx = central.rx ?: return false
    tryWrite(id, WRITE_RETRIES) { writeRx(central.gatt, rx, frame) }
    return true
  }

  /** Starts a write; a busy stack is retried briefly before the link fails. */
  private fun tryWrite(id: Int, triesLeft: Int, attempt: () -> Boolean) {
    val link = links[id] ?: return
    if (link.closed || attempt()) return
    if (triesLeft <= 0) return link.onWriteComplete(false)
    handler.postDelayed({ guard { tryWrite(id, triesLeft - 1, attempt) } }, WRITE_RETRY_MS)
  }

  // ---- Peripheral role (the peer connects to our GATT server) --------------------------------

  private object ServerCallback : BluetoothGattServerCallback() {
    override fun onServiceAdded(status: Int, service: BluetoothGattService) = post { serviceAdded(status) }

    override fun onConnectionStateChange(device: BluetoothDevice, status: Int, newState: Int) {
      // Also fires for connections we opened as a client; only our server links react.
      if (newState != BluetoothProfile.STATE_DISCONNECTED) return
      val address = device.address
      post {
        serverMtu.remove(address)
        serverLinks[address]?.let { links[it] }?.let { failLink(it, "disconnected") }
      }
    }

    override fun onMtuChanged(device: BluetoothDevice, mtu: Int) {
      val address = device.address
      post {
        serverMtu[address] = mtu
        serverLinks[address]?.let { links[it] }?.mtu = mtu
      }
    }

    override fun onCharacteristicWriteRequest(
      device: BluetoothDevice,
      requestId: Int,
      characteristic: BluetoothGattCharacteristic,
      preparedWrite: Boolean,
      responseNeeded: Boolean,
      offset: Int,
      value: ByteArray?,
    ) {
      val frame = value?.copyOf()
      val usable = characteristic.uuid == RX_UUID && !preparedWrite && offset == 0 && frame != null
      val address = device.address
      post {
        if (responseNeeded) {
          val status = if (usable) BluetoothGatt.GATT_SUCCESS else BluetoothGatt.GATT_REQUEST_NOT_SUPPORTED
          server?.sendResponse(device, requestId, status, 0, null)
        }
        if (usable && frame != null) serverLinks[address]?.let { links[it] }?.onFrame(frame)
      }
    }

    override fun onDescriptorWriteRequest(
      device: BluetoothDevice,
      requestId: Int,
      descriptor: BluetoothGattDescriptor,
      preparedWrite: Boolean,
      responseNeeded: Boolean,
      offset: Int,
      value: ByteArray?,
    ) {
      val isCccd = descriptor.uuid == CCCD_UUID && descriptor.characteristic?.uuid == TX_UUID
      val enable = value?.contentEquals(BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE) == true
      val address = device.address
      post {
        if (responseNeeded) server?.sendResponse(device, requestId, BluetoothGatt.GATT_SUCCESS, 0, null)
        if (!isCccd) return@post
        if (enable) {
          acceptPeripheral(device)
        } else {
          serverLinks[address]?.let { links[it] }?.let { failLink(it, "peer unsubscribed") }
        }
      }
    }

    override fun onDescriptorReadRequest(
      device: BluetoothDevice,
      requestId: Int,
      offset: Int,
      descriptor: BluetoothGattDescriptor,
    ) {
      val address = device.address
      post {
        val value = if (serverLinks.containsKey(address)) {
          BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE
        } else {
          BluetoothGattDescriptor.DISABLE_NOTIFICATION_VALUE
        }
        server?.sendResponse(device, requestId, BluetoothGatt.GATT_SUCCESS, 0, value)
      }
    }

    override fun onNotificationSent(device: BluetoothDevice, status: Int) {
      val address = device.address
      post { serverLinks[address]?.let { links[it] }?.onWriteComplete(status == BluetoothGatt.GATT_SUCCESS) }
    }

    override fun onPhyUpdate(device: BluetoothDevice, txPhy: Int, rxPhy: Int, status: Int) {
      val address = device.address
      post {
        serverLinks[address]?.let { links[it] }?.let {
          it.txPhy = txPhy
          it.rxPhy = rxPhy
          log("link ${it.id}: PHY tx $txPhy rx $rxPhy")
        }
      }
    }
  }

  /** The peer subscribed to our TX: it is acting as a client of our service. */
  private fun acceptPeripheral(device: BluetoothDevice) {
    val address = device.address
    if (serverLinks.containsKey(address)) return
    if (!wanted || links.size >= MAX_LINKS) {
      log("refused $address (${if (wanted) "too many links" else "nearby is off"})")
      server?.cancelConnection(device)
      return
    }
    val id = nextLinkId++
    val link = Link(id, Role.PERIPHERAL, address, token.copyOf(), { frame -> peripheralNotify(id, device, frame) }, Listener)
    link.mtu = serverMtu[address] ?: Frames.DEFAULT_MTU
    links[id] = link
    serverLinks[address] = id
    peripheralDevices[id] = device
    log("link $id: $address subscribed (MTU ${link.mtu})")
    link.start()
    handler.postDelayed({ guard { if (!link.closed && !link.up) failLink(link, "timeout") } }, CONNECT_TIMEOUT_MS)
  }

  private fun peripheralNotify(id: Int, device: BluetoothDevice, frame: ByteArray): Boolean {
    val gattServer = server ?: return false
    val tx = serverTx ?: return false
    tryWrite(id, WRITE_RETRIES) { notifyTx(gattServer, device, tx, frame) }
    return true
  }

  // ---- Links ---------------------------------------------------------------------------------

  private object Listener : LinkListener {
    override fun onHello(link: Link) = maybeUp(link)

    override fun onPacket(link: Link, packet: ByteArray) = deliver(link, packet)

    override fun onPeerToken(link: Link) = log("link ${link.id}: peer rotated its token")

    override fun onFailure(link: Link, reason: String) = failLink(link, reason)
  }

  private fun maybeUp(link: Link) {
    if (!link.up || link.upAt != 0L) return
    // Both phones may have connected to each other. Both keep the link whose central has the
    // lower HELLO token, so they close the same one.
    val duplicate = links.values.firstOrNull { other ->
      other !== link && other.upAt != 0L && link.peerTokens.any { other.knowsToken(it) }
    }
    if (duplicate != null && compareTokens(centralToken(duplicate), centralToken(link)) < 0) {
      log("link ${link.id}: duplicate of link ${duplicate.id}, closing it")
      pendingConnects.remove(link.id)?.invoke(linkMap(duplicate), null)
      failLink(link, "duplicate")
      return
    }
    link.upAt = System.currentTimeMillis()
    log("link ${link.id}: up (${link.role.label}, MTU ${link.mtu}, ${link.upAt - link.createdAt} ms)")
    emit("linkUp", linkMap(link))
    pendingConnects.remove(link.id)?.invoke(linkMap(link), null)
    if (duplicate != null) {
      log("link ${duplicate.id}: duplicate of link ${link.id}, closing it")
      failLink(duplicate, "duplicate")
    }
  }

  private fun centralToken(link: Link): ByteArray =
    if (link.role == Role.CENTRAL) link.localToken else link.peerTokens.first()

  private fun failLink(link: Link, reason: String) {
    if (links.remove(link.id) == null) return
    val unsent = link.unsent
    val wasUp = link.upAt != 0L
    link.close()
    centrals.remove(link.id)?.gatt?.let { gatt ->
      try {
        gatt.disconnect()
      } catch (_: Exception) {
      }
      gatt.close()
    }
    peripheralDevices.remove(link.id)?.let { device ->
      if (serverLinks[link.address] == link.id) serverLinks.remove(link.address)
      // A duplicate may share its connection with the link we keep: leave the connection up.
      if (reason != "duplicate" && reason != "disconnected" && reason != "bluetooth_off") {
        try {
          server?.cancelConnection(device)
        } catch (_: Exception) {
        }
      }
    }
    pendingConnects.remove(link.id)?.invoke(null, reason)
    log("link ${link.id}: down ($reason${if (unsent > 0) ", $unsent unsent" else ""})")
    if (wasUp) {
      emit("linkDown", mapOf("id" to link.id, "address" to link.address, "reason" to reason, "unsent" to unsent))
    }
  }

  private fun deliver(link: Link, packet: ByteArray) {
    val notify: Boolean
    val queued: Int
    synchronized(inboundLock) {
      inbound.addLast(link.id to packet)
      queued = inbound.size
      notify = !inboundNotified
      inboundNotified = true
    }
    if (notify) emit("packet", mapOf("queued" to queued))
  }

  // ---- State ---------------------------------------------------------------------------------

  private fun unsupportedReason(): String? {
    val ctx = context ?: return "not_attached"
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return "android_too_old"
    if (!ctx.packageManager.hasSystemFeature(PackageManager.FEATURE_BLUETOOTH_LE)) return "no_ble"
    if (adapter == null) return "no_bluetooth"
    return null
  }

  private fun missingPermissions(): List<String> {
    val ctx = context ?: return emptyList()
    val needed = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      listOf(
        Manifest.permission.BLUETOOTH_SCAN,
        Manifest.permission.BLUETOOTH_ADVERTISE,
        Manifest.permission.BLUETOOTH_CONNECT,
      )
    } else {
      listOf(Manifest.permission.ACCESS_FINE_LOCATION)
    }
    return needed
      .filter { ctx.checkSelfPermission(it) != PackageManager.PERMISSION_GRANTED }
      .map { it.removePrefix("android.permission.") }
  }

  private fun stateMap(): Map<String, Any?> {
    val bt = adapter
    val modern = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && bt != null
    return mapOf(
      "supported" to (unsupportedReason() == null),
      "unsupportedReason" to unsupportedReason(),
      "enabled" to (bt?.isEnabled == true),
      "missingPermissions" to missingPermissions(),
      "running" to wanted,
      "advertising" to advertising,
      "scanning" to scanning,
      "autoConnect" to config.autoConnect,
      "rotationSeconds" to (config.rotationMs / 1000).toInt(),
      "token" to hex(token),
      "foregroundService" to foreground,
      "le2MPhy" to (modern && bt?.isLe2MPhySupported == true),
      "extendedAdvertising" to (modern && bt?.isLeExtendedAdvertisingSupported == true),
      "multipleAdvertisement" to (bt?.isMultipleAdvertisementSupported == true),
      "sdk" to Build.VERSION.SDK_INT,
      "device" to "${Build.MANUFACTURER} ${Build.MODEL}",
      "power" to context?.let { powerMap(it) },
      "inboundQueued" to synchronized(inboundLock) { inbound.size },
      "links" to links.values.sortedBy { it.id }.map { linkMap(it) },
      "peers" to peers.entries.map { (address, peer) -> peerMap(address, peer) },
    )
  }

  private fun powerMap(ctx: Context): Map<String, Any?> {
    val power = ctx.getSystemService(Context.POWER_SERVICE) as PowerManager
    val battery = ctx.getSystemService(Context.BATTERY_SERVICE) as BatteryManager
    val process = ActivityManager.RunningAppProcessInfo().also { ActivityManager.getMyMemoryState(it) }
    return mapOf(
      "batteryPercent" to battery.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY),
      "charging" to battery.isCharging,
      "powerSave" to power.isPowerSaveMode,
      "deviceIdle" to power.isDeviceIdleMode,
      "ignoringBatteryOptimizations" to power.isIgnoringBatteryOptimizations(ctx.packageName),
      "interactive" to power.isInteractive,
      "importance" to process.importance,
    )
  }

  private fun linkMap(link: Link): Map<String, Any?> = mapOf(
    "id" to link.id,
    "role" to link.role.label,
    "address" to link.address,
    "peerToken" to link.peerTokens.lastOrNull()?.let { hex(it) },
    "up" to link.up,
    "mtu" to link.mtu,
    "txPhy" to link.txPhy,
    "rxPhy" to link.rxPhy,
    "setupMs" to (if (link.upAt != 0L) (link.upAt - link.createdAt).toDouble() else null),
    "upAt" to link.upAt.toDouble(),
    "packetsSent" to link.packetsSent.toDouble(),
    "packetsReceived" to link.packetsReceived.toDouble(),
    "bytesSent" to link.bytesSent.toDouble(),
    "bytesReceived" to link.bytesReceived.toDouble(),
    "framesSent" to link.framesSent.toDouble(),
    "framesReceived" to link.framesReceived.toDouble(),
    "unsent" to link.unsent,
    "outboundBytes" to link.outboundBytes.toDouble(),
    "sendCredits" to link.sendCredits,
  )

  private fun peerMap(address: String, peer: Peer): Map<String, Any?> = mapOf(
    "address" to address,
    "token" to peer.token?.let { hex(it) },
    "rssi" to peer.rssi,
    "seenAgoMs" to (SystemClock.elapsedRealtime() - peer.lastSeen).toDouble(),
    "knownForMs" to (SystemClock.elapsedRealtime() - peer.firstSeen).toDouble(),
    "linked" to links.values.any { it.address == address || (peer.token?.let { t -> it.knowsToken(t) } == true) },
  )

  private fun emitState() = emit("stateChanged", stateMap())

  private fun log(message: String) =
    emit("log", mapOf("message" to message, "at" to System.currentTimeMillis().toDouble()))

  private fun emit(name: String, body: Map<String, Any?>) {
    try {
      emitter?.invoke(name, body)
    } catch (error: Exception) {
      Log.w(TAG, "event $name not delivered", error)
    }
  }

  // ---- Helpers -------------------------------------------------------------------------------

  private fun newToken(): ByteArray = ByteArray(Frames.TOKEN_BYTES).also { random.nextBytes(it) }

  private fun compareTokens(a: ByteArray, b: ByteArray): Int {
    for (i in 0 until minOf(a.size, b.size)) {
      val diff = (a[i].toInt() and 0xff) - (b[i].toInt() and 0xff)
      if (diff != 0) return diff
    }
    return a.size - b.size
  }

  fun hex(bytes: ByteArray): String {
    val digits = "0123456789abcdef"
    val out = StringBuilder(bytes.size * 2)
    for (b in bytes) {
      out.append(digits[(b.toInt() shr 4) and 0xf])
      out.append(digits[b.toInt() and 0xf])
    }
    return out.toString()
  }

  /** Runs [block] on the engine thread; exceptions are logged, never thrown into Bluetooth. */
  private fun post(block: () -> Unit) {
    handler.post { guard(block) }
  }

  private fun guard(block: () -> Unit) {
    try {
      block()
    } catch (error: SecurityException) {
      log("a Bluetooth permission was revoked")
      emitState()
    } catch (error: Exception) {
      Log.w(TAG, "nearby engine error", error)
      log("engine error: ${error.javaClass.simpleName}")
    }
  }

  /** Like [post], but a failure answers [reply] instead of being lost. */
  private fun request(reply: Reply, block: () -> Unit) {
    handler.post {
      try {
        block()
      } catch (error: SecurityException) {
        reply(null, "permission")
      } catch (error: Exception) {
        Log.w(TAG, "nearby request failed", error)
        reply(null, "error")
      }
    }
  }
}

package com.pingdost.calls

import android.graphics.Bitmap
import android.graphics.Matrix
import android.graphics.PointF
import android.media.FaceDetector
import android.opengl.GLES20
import android.os.SystemClock
import android.util.Log
import com.oney.WebRTCModule.videoEffects.ProcessorProvider
import com.oney.WebRTCModule.videoEffects.VideoFrameProcessor
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean
import org.webrtc.GlRectDrawer
import org.webrtc.GlShader
import org.webrtc.GlTextureFrameBuffer
import org.webrtc.GlUtil
import org.webrtc.SurfaceTextureHelper
import org.webrtc.TextureBufferImpl
import org.webrtc.VideoFrame
import org.webrtc.VideoFrameDrawer
import org.webrtc.YuvConverter

/**
 * Camera filters and effects for video calls (ADR 0038). JS picks an effect and hands over its
 * complete fragment shader (`@pingdost/call-engine` `effectFragmentShader`, the same source
 * the web compiles); every camera track carries the
 * react-native-webrtc video processor `pingdost-effects`, which runs it on each frame before
 * WebRTC encodes it (so the other side and the self view see the same picture, and nothing
 * unprocessed leaves the phone).
 *
 * Per frame, on the camera's GL thread: draw the frame upright into a texture, then draw the
 * effect into a pooled texture handed to WebRTC as an RGB texture frame. Face effects add
 * Android's built-in `FaceDetector` (no library, no network) on a small copy, a few times a
 * second, on a worker thread; its result is smoothed into the `uFace` uniforms.
 */
object CallEffects {
  const val PROCESSOR = "pingdost-effects"
  private const val TAG = "PingdostCalls"

  class Effect(val id: String, val shader: String, val face: Boolean)

  /** The effect for the camera of the live call; null: frames pass unchanged. */
  @Volatile var current: Effect? = null

  /** One worker for every camera's face tracking. */
  internal val faces: ExecutorService by lazy {
    Executors.newSingleThreadExecutor { run ->
      Thread(run, "pingdost-faces").apply { isDaemon = true }
    }
  }

  private var registered = false

  @Synchronized
  fun register() {
    if (registered) return
    try {
      ProcessorProvider.addProcessor(PROCESSOR) { EffectsProcessor() }
      registered = true
    } catch (error: RuntimeException) {
      Log.w(TAG, "effects not registered: ${error.javaClass.simpleName}")
    }
  }
}

private val IDENTITY = floatArrayOf(1f, 0f, 0f, 0f, 0f, 1f, 0f, 0f, 0f, 0f, 1f, 0f, 0f, 0f, 0f, 1f)

/** `EFFECT_VERTEX_SHADER` in `@pingdost/call-engine` (and WebRTC's own drawers). */
private const val VERTEX_SHADER =
  "varying vec2 tc;\n" +
    "attribute vec4 in_pos;\n" +
    "attribute vec4 in_tc;\n" +
    "uniform mat4 tex_mat;\n" +
    "void main() {\n" +
    "  gl_Position = in_pos;\n" +
    "  tc = (tex_mat * in_tc).xy;\n" +
    "}\n"

private val QUAD = GlUtil.createFloatBuffer(floatArrayOf(-1f, -1f, 1f, -1f, -1f, 1f, 1f, 1f))
private val QUAD_TC = GlUtil.createFloatBuffer(floatArrayOf(0f, 0f, 1f, 0f, 0f, 1f, 1f, 1f))

private fun uniform(shader: GlShader, name: String): Int =
  try {
    shader.getUniformLocation(name)
  } catch (error: RuntimeException) {
    -1 // Not used by this effect (the compiler dropped it).
  }

/** One effect's program: draws a texture through the effect into the bound framebuffer. */
private class EffectProgram(fragmentShader: String) {
  private val shader = GlShader(VERTEX_SHADER, fragmentShader)
  private val tex = uniform(shader, "tex")
  private val texMatrix = uniform(shader, "tex_mat")
  private val size = uniform(shader, "uSize")
  private val time = uniform(shader, "uTime")
  private val face = uniform(shader, "uFace")
  private val faceOn = uniform(shader, "uFaceOn")

  fun draw(texture: Int, width: Int, height: Int, seconds: Float, anchor: FloatArray) {
    shader.useProgram()
    GLES20.glViewport(0, 0, width, height)
    if (tex >= 0) GLES20.glUniform1i(tex, 0)
    if (texMatrix >= 0) GLES20.glUniformMatrix4fv(texMatrix, 1, false, IDENTITY, 0)
    if (size >= 0) GLES20.glUniform2f(size, width.toFloat(), height.toFloat())
    if (time >= 0) GLES20.glUniform1f(time, seconds)
    if (face >= 0) GLES20.glUniform4f(face, anchor[0], anchor[1], anchor[2], anchor[3])
    if (faceOn >= 0) GLES20.glUniform1f(faceOn, anchor[4])
    shader.setVertexAttribArray("in_pos", 2, QUAD)
    shader.setVertexAttribArray("in_tc", 2, QUAD_TC)
    GLES20.glActiveTexture(GLES20.GL_TEXTURE0)
    GLES20.glBindTexture(GLES20.GL_TEXTURE_2D, texture)
    GLES20.glDrawArrays(GLES20.GL_TRIANGLE_STRIP, 0, 4)
    GLES20.glBindTexture(GLES20.GL_TEXTURE_2D, 0)
  }

  fun release() {
    shader.release()
  }
}

/** One camera track's processor; it lives as long as the track. Runs on the camera's GL thread. */
private class EffectsProcessor : VideoFrameProcessor {
  private companion object {
    const val TAG = "PingdostCalls"
    /** Frames WebRTC may hold at once (encoder, self view) before this skips the effect. */
    const val MAX_BUFFERS = 6
  }

  private val frameDrawer = VideoFrameDrawer()
  private val faces = FaceTracker()
  private val startedAt = SystemClock.elapsedRealtime()
  private var copy: GlRectDrawer? = null
  private var upright: GlTextureFrameBuffer? = null
  private var program: EffectProgram? = null
  private var programId: String? = null
  private var failedId: String? = null
  private val free = ArrayDeque<GlTextureFrameBuffer>()
  private var outstanding = 0
  private var yuv: YuvConverter? = null
  private var holding = false

  override fun process(frame: VideoFrame, textureHelper: SurfaceTextureHelper): VideoFrame? {
    val effect = CallEffects.current
    if (effect == null || effect.id == failedId) {
      releaseGl()
      return null
    }
    return try {
      render(frame, effect, textureHelper)
    } catch (error: RuntimeException) {
      // E.g. a shader this GPU does not compile: that effect is skipped from now on.
      Log.w(TAG, "effect ${effect.id} failed: ${error.message}")
      failedId = effect.id
      GLES20.glBindFramebuffer(GLES20.GL_FRAMEBUFFER, 0)
      releaseGl()
      null
    }
  }

  private fun render(frame: VideoFrame, effect: CallEffects.Effect, helper: SurfaceTextureHelper): VideoFrame? {
    val width = frame.rotatedWidth
    val height = frame.rotatedHeight
    if (width <= 0 || height <= 0) return null
    holding = true
    val copy = copy ?: GlRectDrawer().also { copy = it }
    val upright = upright ?: GlTextureFrameBuffer(GLES20.GL_RGBA).also { upright = it }
    upright.setSize(width, height)

    // 1. The frame as it looks on screen (rotation applied, top up).
    GLES20.glBindFramebuffer(GLES20.GL_FRAMEBUFFER, upright.frameBufferId)
    frameDrawer.drawFrame(frame, copy, null, 0, 0, width, height)
    if (effect.face) faces.feed(upright.textureId, width, height, copy) else faces.reset()

    // 2. The effect, into a texture of its own that WebRTC keeps while it needs it.
    val out = takeBuffer(width, height)
    if (out == null) {
      GLES20.glBindFramebuffer(GLES20.GL_FRAMEBUFFER, 0)
      return null
    }
    GLES20.glBindFramebuffer(GLES20.GL_FRAMEBUFFER, out.frameBufferId)
    try {
      if (programId != effect.id) {
        program?.release()
        program = null
        program = EffectProgram(effect.shader)
        programId = effect.id
      }
      val seconds = (SystemClock.elapsedRealtime() - startedAt) / 1000f
      program!!.draw(upright.textureId, width, height, seconds, faces.anchor(width, height))
    } catch (error: RuntimeException) {
      giveBack(out)
      throw error
    }
    GLES20.glBindFramebuffer(GLES20.GL_FRAMEBUFFER, 0)
    // The encoder and the self view read the texture from their own GL contexts.
    GLES20.glFinish()

    outstanding++
    val handler = helper.handler
    val converter = yuv ?: YuvConverter().also { yuv = it }
    val buffer =
      TextureBufferImpl(
        width,
        height,
        VideoFrame.TextureBuffer.Type.RGB,
        out.textureId,
        Matrix(),
        handler,
        converter,
      ) {
        handler.post { giveBack(out) }
      }
    return VideoFrame(buffer, 0, frame.timestampNs)
  }

  private fun takeBuffer(width: Int, height: Int): GlTextureFrameBuffer? {
    val buffer = free.removeFirstOrNull()
    if (buffer != null) {
      buffer.setSize(width, height)
      return buffer
    }
    if (outstanding + free.size >= MAX_BUFFERS) return null
    return GlTextureFrameBuffer(GLES20.GL_RGBA).also { it.setSize(width, height) }
  }

  private fun giveBack(buffer: GlTextureFrameBuffer) {
    outstanding--
    if (holding && free.size < MAX_BUFFERS) free.addLast(buffer) else buffer.release()
    if (!holding && outstanding == 0) {
      yuv?.release()
      yuv = null
    }
  }

  /** Frees the GL objects while no effect runs (the camera's GL thread). */
  private fun releaseGl() {
    if (!holding) return
    holding = false
    copy?.release()
    copy = null
    upright?.release()
    upright = null
    program?.release()
    program = null
    programId = null
    while (free.isNotEmpty()) free.removeFirst().release()
    frameDrawer.release()
    faces.reset()
    faces.releaseGl()
    if (outstanding == 0) {
      yuv?.release()
      yuv = null
    }
  }
}

/**
 * Where the face is, from Android's `FaceDetector` (the point between the eyes and their
 * distance; no roll). Detection runs on a 240-pixel-wide copy every third frame at most, one at
 * a time; frames in between use the last result, smoothed. Lost for 0.8 s, the effect fades.
 */
private class FaceTracker {
  private companion object {
    const val WIDTH = 240
    const val EVERY = 3
    const val LOST_MS = 800L
  }

  private val busy = AtomicBoolean(false)
  @Volatile private var found: FloatArray? = null
  @Volatile private var foundAt = 0L
  private var small: GlTextureFrameBuffer? = null
  private var frames = 0
  private var x = 0f
  private var y = 0f
  private var eyes = 0f
  private var on = 0f
  private var tracking = false
  // Used on the worker thread only.
  private var detector: FaceDetector? = null
  private var detectorWidth = 0
  private var detectorHeight = 0

  fun feed(texture: Int, width: Int, height: Int, copy: GlRectDrawer) {
    if (frames++ % EVERY != 0 || !busy.compareAndSet(false, true)) return
    val w = WIDTH
    val h = ((WIDTH.toLong() * height / width).toInt() / 2) * 2
    if (h < 2) {
      busy.set(false)
      return
    }
    val buffer = small ?: GlTextureFrameBuffer(GLES20.GL_RGBA).also { small = it }
    buffer.setSize(w, h)
    GLES20.glBindFramebuffer(GLES20.GL_FRAMEBUFFER, buffer.frameBufferId)
    copy.drawRgb(texture, IDENTITY, width, height, 0, 0, w, h)
    val pixels = ByteBuffer.allocateDirect(w * h * 4).order(ByteOrder.nativeOrder())
    GLES20.glReadPixels(0, 0, w, h, GLES20.GL_RGBA, GLES20.GL_UNSIGNED_BYTE, pixels)
    try {
      CallEffects.faces.execute {
        try {
          detect(pixels, w, h)
        } finally {
          busy.set(false)
        }
      }
    } catch (error: RuntimeException) {
      busy.set(false)
    }
  }

  private fun detect(pixels: ByteBuffer, w: Int, h: Int) {
    val raw = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
    pixels.rewind()
    raw.copyPixelsFromBuffer(pixels)
    // GL rows run bottom-up.
    val upright = Bitmap.createBitmap(raw, 0, 0, w, h, Matrix().apply { preScale(1f, -1f) }, false)
    val rgb = upright.copy(Bitmap.Config.RGB_565, false)
    raw.recycle()
    upright.recycle()
    if (detector == null || detectorWidth != w || detectorHeight != h) {
      detector = FaceDetector(w, h, 1)
      detectorWidth = w
      detectorHeight = h
    }
    val faces = arrayOfNulls<FaceDetector.Face>(1)
    val count = detector!!.findFaces(rgb, faces)
    rgb.recycle()
    val face = faces[0]
    if (count > 0 && face != null && face.confidence() >= 0.35f) {
      val mid = PointF()
      face.getMidPoint(mid)
      found = floatArrayOf(mid.x / w, mid.y / h, face.eyesDistance() / w)
      foundAt = SystemClock.elapsedRealtime()
    }
  }

  /** `uFace` (x, y from the bottom left, eye distance, roll) and `uFaceOn`, in pixels. */
  fun anchor(width: Int, height: Int): FloatArray {
    val f = found
    if (f != null && SystemClock.elapsedRealtime() - foundAt < LOST_MS) {
      val tx = f[0] * width
      val ty = (1f - f[1]) * height
      val te = f[2] * width
      if (!tracking) {
        x = tx
        y = ty
        eyes = te
        tracking = true
      } else {
        x += (tx - x) * 0.35f
        y += (ty - y) * 0.35f
        eyes += (te - eyes) * 0.25f
      }
      on = minOf(1f, on + 0.12f)
    } else {
      on = maxOf(0f, on - 0.06f)
      if (on == 0f) tracking = false
    }
    return floatArrayOf(x, y, eyes, 0f, on)
  }

  fun reset() {
    found = null
    tracking = false
    on = 0f
  }

  fun releaseGl() {
    small?.release()
    small = null
  }
}

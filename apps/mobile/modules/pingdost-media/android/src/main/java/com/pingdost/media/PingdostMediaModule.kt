package com.pingdost.media

import android.content.Context
import android.graphics.Bitmap
import android.media.MediaMetadataRetriever
import android.net.Uri
import android.os.Handler
import android.os.Looper
import androidx.annotation.OptIn
import androidx.media3.common.MediaItem
import androidx.media3.common.MimeTypes
import androidx.media3.common.util.UnstableApi
import androidx.media3.effect.Presentation
import androidx.media3.transformer.AudioEncoderSettings
import androidx.media3.transformer.Composition
import androidx.media3.transformer.DefaultEncoderFactory
import androidx.media3.transformer.EditedMediaItem
import androidx.media3.transformer.Effects
import androidx.media3.transformer.ExportException
import androidx.media3.transformer.ExportResult
import androidx.media3.transformer.ProgressHolder
import androidx.media3.transformer.Transformer
import androidx.media3.transformer.VideoEncoderSettings
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record
import java.io.File
import java.io.FileOutputStream

class CompressOptions : Record {
  /** The output's shorter side in pixels (720 = 720p); never scaled up. */
  @Field val shortSide: Int = 720
  @Field val videoBitrate: Int = 2_000_000
  @Field val audioBitrate: Int = 128_000
}

class FrameOptions : Record {
  @Field val maxSize: Int = 480
  /** JPEG quality, 0–100. */
  @Field val quality: Int = 60
}

private class Job(val transformer: Transformer, val promise: Promise, val output: File)

/**
 * Video work for attachments, all on the device before encryption (REQ §10.2): metadata and a
 * preview frame from MediaMetadataRetriever, and H.264/AAC re-encoding with Media3 Transformer
 * (progress events, cancellable). Nothing here touches the network or logs file contents.
 */
@OptIn(UnstableApi::class)
class PingdostMediaModule : Module() {
  private val jobs = mutableMapOf<String, Job>()
  private val handler = Handler(Looper.getMainLooper())

  private val context: Context
    get() = appContext.reactContext ?: throw CodedException("ERR_NO_CONTEXT", "No app context", null)

  /** A `file://` URI as a path (Transformer writes to paths); other URIs stay as they are. */
  private fun pathOf(uri: String): String {
    val parsed = Uri.parse(uri)
    return if (parsed.scheme == "file") parsed.path ?: uri else uri
  }

  private fun <T> withRetriever(uri: String, read: (MediaMetadataRetriever) -> T): T {
    val retriever = MediaMetadataRetriever()
    try {
      retriever.setDataSource(context, Uri.parse(uri))
      return read(retriever)
    } catch (error: IllegalArgumentException) {
      throw CodedException("ERR_NOT_MEDIA", "This file cannot be read as a video", error)
    } catch (error: RuntimeException) {
      throw CodedException("ERR_NOT_MEDIA", "This file cannot be read as a video", error)
    } finally {
      retriever.release()
    }
  }

  override fun definition() = ModuleDefinition {
    Name("PingdostMedia")
    Events("onCompressProgress")

    AsyncFunction("videoInfo") { uri: String ->
      withRetriever(uri) { retriever ->
        fun number(key: Int) = retriever.extractMetadata(key)?.toLongOrNull() ?: 0L
        val rotation = number(MediaMetadataRetriever.METADATA_KEY_VIDEO_ROTATION).toInt()
        var width = number(MediaMetadataRetriever.METADATA_KEY_VIDEO_WIDTH)
        var height = number(MediaMetadataRetriever.METADATA_KEY_VIDEO_HEIGHT)
        // As shown: a portrait recording is stored landscape with a rotation.
        if (rotation == 90 || rotation == 270) {
          val stored = width
          width = height
          height = stored
        }
        mapOf(
          "durationMs" to number(MediaMetadataRetriever.METADATA_KEY_DURATION).toDouble(),
          "width" to width.toDouble(),
          "height" to height.toDouble(),
          "bitrate" to number(MediaMetadataRetriever.METADATA_KEY_BITRATE).toDouble(),
          "hasAudio" to (retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_HAS_AUDIO) == "yes"),
          "hasVideo" to (retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_HAS_VIDEO) == "yes"),
        )
      }
    }

    AsyncFunction("videoFrame") { uri: String, outputUri: String, options: FrameOptions ->
      withRetriever(uri) { retriever ->
        val frame = retriever.getFrameAtTime(0, MediaMetadataRetriever.OPTION_CLOSEST_SYNC)
          ?: throw CodedException("ERR_NO_FRAME", "The video has no frame to preview", null)
        val scale = minOf(1f, options.maxSize.toFloat() / maxOf(frame.width, frame.height))
        val shown =
          if (scale < 1f) {
            Bitmap.createScaledBitmap(
              frame,
              (frame.width * scale).toInt().coerceAtLeast(1),
              (frame.height * scale).toInt().coerceAtLeast(1),
              true,
            )
          } else {
            frame
          }
        FileOutputStream(File(pathOf(outputUri))).use { out ->
          shown.compress(Bitmap.CompressFormat.JPEG, options.quality.coerceIn(1, 100), out)
        }
        mapOf("width" to shown.width.toDouble(), "height" to shown.height.toDouble())
      }
    }

    // Transformer must be built, started, polled and cancelled on one looper thread: the main one.
    AsyncFunction("compressVideo") { id: String, inputUri: String, outputUri: String, options: CompressOptions, promise: Promise ->
      if (jobs.containsKey(id)) {
        promise.reject(CodedException("ERR_BUSY", "This compression is already running", null))
        return@AsyncFunction
      }
      val output = File(pathOf(outputUri))
      val encoders = DefaultEncoderFactory.Builder(context)
        .setRequestedVideoEncoderSettings(
          VideoEncoderSettings.Builder().setBitrate(options.videoBitrate).build(),
        )
        .setRequestedAudioEncoderSettings(
          AudioEncoderSettings.Builder().setBitrate(options.audioBitrate).build(),
        )
        // A device encoder that cannot do the exact size or bitrate picks the nearest it can.
        .setEnableFallback(true)
        .build()
      val item = EditedMediaItem.Builder(MediaItem.fromUri(Uri.parse(inputUri)))
        .setEffects(Effects(listOf(), listOf(Presentation.createForShortSide(options.shortSide))))
        .build()
      val transformer = Transformer.Builder(context)
        .setVideoMimeType(MimeTypes.VIDEO_H264)
        .setAudioMimeType(MimeTypes.AUDIO_AAC)
        .setEncoderFactory(encoders)
        .addListener(
          object : Transformer.Listener {
            override fun onCompleted(composition: Composition, exportResult: ExportResult) {
              val job = jobs.remove(id) ?: return
              job.promise.resolve(mapOf("size" to job.output.length().toDouble()))
            }

            override fun onError(
              composition: Composition,
              exportResult: ExportResult,
              exportException: ExportException,
            ) {
              val job = jobs.remove(id) ?: return
              job.output.delete()
              job.promise.reject(
                CodedException("ERR_COMPRESS", "Compression failed: ${exportException.errorCodeName}", null),
              )
            }
          },
        )
        .build()
      jobs[id] = Job(transformer, promise, output)
      val progress = ProgressHolder()
      val poll = object : Runnable {
        override fun run() {
          if (jobs[id]?.transformer !== transformer) return
          if (transformer.getProgress(progress) == Transformer.PROGRESS_STATE_AVAILABLE) {
            sendEvent("onCompressProgress", mapOf("id" to id, "progress" to progress.progress))
          }
          handler.postDelayed(this, 250)
        }
      }
      try {
        transformer.start(item, output.path)
      } catch (error: RuntimeException) {
        jobs.remove(id)
        promise.reject(CodedException("ERR_COMPRESS", "Compression could not start", error))
        return@AsyncFunction
      }
      handler.post(poll)
    }.runOnQueue(Queues.MAIN)

    AsyncFunction("cancelCompression") { id: String ->
      val job = jobs.remove(id) ?: return@AsyncFunction
      job.transformer.cancel()
      job.output.delete()
      job.promise.reject(CodedException("ERR_CANCELLED", "Compression was cancelled", null))
    }.runOnQueue(Queues.MAIN)

    OnDestroy {
      handler.post {
        for (job in jobs.values) {
          job.transformer.cancel()
          job.output.delete()
        }
        jobs.clear()
      }
    }
  }
}

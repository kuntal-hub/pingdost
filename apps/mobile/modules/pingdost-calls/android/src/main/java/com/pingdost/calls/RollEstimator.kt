package com.pingdost.calls

import kotlin.math.cos
import kotlin.math.roundToInt
import kotlin.math.sin

/**
 * The head's roll from the eye line (ADR 0048). Android's `FaceDetector` gives the point between
 * the eyes and their distance, but no angle (its pose is always 0). Eyes are darker than the skin
 * around them, so this turns a pair of probes about that point and keeps the angle at which both
 * probes are darkest, refined between steps. Pure Kotlin on a luminance grid (JVM-tested).
 *
 * Coordinates: x right, y up (GL rows, bottom row first). The result is the eye line's angle,
 * counter-clockwise in radians: what the shaders' `uFace.w` expects.
 */
internal object RollEstimator {
  /** The largest roll looked for (about 34°); `FaceDetector` loses faces tilted much further. */
  const val MAX = 0.6f
  private const val STEP = 0.05f
  /** How much darker the best angle must be than the average one (luminance 0..1, per eye). */
  private const val MIN_CONTRAST = 0.025f

  /** The roll, or null when the eyes do not stand out (closed, glare, too small, too dark). */
  fun estimate(
    luma: FloatArray,
    width: Int,
    height: Int,
    midX: Float,
    midY: Float,
    eyes: Float,
  ): Float? {
    if (eyes < 6f || luma.size < width * height) return null
    val steps = (2 * MAX / STEP).roundToInt()
    val scores = FloatArray(steps + 1)
    var best = 0
    for (i in 0..steps) {
      val a = -MAX + i * STEP
      val ux = cos(a)
      val uy = sin(a)
      val dx = ux * eyes / 2
      val dy = uy * eyes / 2
      // The detector's midpoint can sit a little above or below the eyes: try a few offsets
      // across the eye line and keep the best.
      var score = Float.MAX_VALUE
      for (k in -4..4) {
        val o = k * 0.03f * eyes
        val cx = midX - uy * o
        val cy = midY + ux * o
        val s =
          probe(luma, width, height, cx - dx, cy - dy, ux, uy, eyes) +
            probe(luma, width, height, cx + dx, cy + dy, ux, uy, eyes)
        if (s < score) score = s
      }
      // A slight preference for level when angles tie.
      scores[i] = score + 0.02f * a * a
      if (scores[i] < scores[best]) best = i
    }
    val mean = scores.average().toFloat()
    if ((mean - scores[best]) / 2 < MIN_CONTRAST) return null
    var offset = 0f
    if (best in 1 until steps) {
      // A parabola through the best angle and its neighbours.
      val l = scores[best - 1]
      val c = scores[best]
      val r = scores[best + 1]
      val curve = l - 2 * c + r
      if (curve > 1e-6f) offset = (0.5f * (l - r) / curve).coerceIn(-0.5f, 0.5f)
    }
    return -MAX + (best + offset) * STEP
  }

  /**
   * Mean luminance over a thin strip along the eye line (u) through one eye: an eye is wide
   * and short, so the strip is darkest when it lies along the eye, not across it.
   */
  private fun probe(
    luma: FloatArray,
    width: Int,
    height: Int,
    cx: Float,
    cy: Float,
    ux: Float,
    uy: Float,
    eyes: Float,
  ): Float {
    var sum = 0f
    for (j in -1..1) {
      for (i in -3..3) {
        val along = i * 0.06f * eyes
        val across = j * 0.035f * eyes
        sum += at(luma, width, height, cx + ux * along - uy * across, cy + uy * along + ux * across)
      }
    }
    return sum / 21f
  }

  /** Bilinear luminance; outside the picture counts as white. */
  private fun at(luma: FloatArray, width: Int, height: Int, x: Float, y: Float): Float {
    if (x < 0f || y < 0f || x > width - 1f || y > height - 1f) return 1f
    val x0 = x.toInt()
    val y0 = y.toInt()
    val x1 = minOf(x0 + 1, width - 1)
    val y1 = minOf(y0 + 1, height - 1)
    val fx = x - x0
    val fy = y - y0
    val top = luma[y0 * width + x0] * (1 - fx) + luma[y0 * width + x1] * fx
    val bottom = luma[y1 * width + x0] * (1 - fx) + luma[y1 * width + x1] * fx
    return top * (1 - fy) + bottom * fy
  }
}

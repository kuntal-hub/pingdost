package com.pingdost.calls

import kotlin.math.abs
import kotlin.math.cos
import kotlin.math.sin
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test

class RollEstimatorTest {
  private val width = 240
  private val height = 320

  /** A light face with two dark eyes and darker brows above them, tilted by `roll`. */
  private fun face(midX: Float, midY: Float, eyes: Float, roll: Float, noise: Boolean = true): FloatArray {
    val luma = FloatArray(width * height) { 0.72f }
    val random = java.util.Random(7)
    val c = cos(roll)
    val s = sin(roll)
    for (y in 0 until height) {
      for (x in 0 until width) {
        // Face-local coordinates: eyes at (±0.5, 0), y up.
        val vx = x - midX
        val vy = y - midY
        val qx = (c * vx + s * vy) / eyes
        val qy = (-s * vx + c * vy) / eyes
        var value = 0.72f
        val ex = abs(qx) - 0.5f
        if (ex * ex / 0.035f + qy * qy / 0.008f < 1f) value = 0.18f // eye
        val bx = abs(qx) - 0.5f
        val by = qy - 0.32f
        if (bx * bx / 0.06f + by * by / 0.002f < 1f) value = 0.35f // brow
        if (qy < -1.0f && qy > -1.08f && abs(qx) < 0.3f) value = 0.4f // mouth
        if (noise) value += (random.nextFloat() - 0.5f) * 0.08f
        luma[y * width + x] = value
      }
    }
    return luma
  }

  @Test
  fun findsTheEyeLineAngle() {
    for (roll in floatArrayOf(-0.45f, -0.2f, 0f, 0.12f, 0.3f, 0.5f)) {
      val luma = face(120f, 190f, 46f, roll)
      val found = RollEstimator.estimate(luma, width, height, 120f, 190f, 46f)
      assertNotNull("roll $roll", found)
      assertEquals("roll $roll", roll, found!!, 0.05f)
    }
  }

  @Test
  fun copesWithAMidpointThatIsSlightlyOff() {
    val luma = face(120f, 190f, 46f, 0.25f)
    val found = RollEstimator.estimate(luma, width, height, 123f, 187f, 44f)
    assertEquals(0.25f, found!!, 0.08f)
  }

  @Test
  fun givesUpWithoutEyes() {
    val blank = FloatArray(width * height) { 0.6f }
    assertNull(RollEstimator.estimate(blank, width, height, 120f, 190f, 46f))
    assertNull(RollEstimator.estimate(blank, width, height, 120f, 190f, 3f))
  }
}

/**
 * Shared vision types. Everything downstream of the worker speaks this.
 */

export interface Landmark {
  x: number; // normalised 0..1 across frame width
  y: number; // normalised 0..1 across frame height
  z: number; // depth, roughly in the same scale as x (negative = toward camera)
  visibility: number; // 0..1 confidence this landmark is actually visible
}

/** MediaPipe pose landmark indices. Left/right are the SUBJECT's own sides. */
export const POSE = {
  NOSE: 0,
  LEFT_EYE_INNER: 1,
  LEFT_EYE: 2,
  LEFT_EYE_OUTER: 3,
  RIGHT_EYE_INNER: 4,
  RIGHT_EYE: 5,
  RIGHT_EYE_OUTER: 6,
  LEFT_EAR: 7,
  RIGHT_EAR: 8,
  MOUTH_LEFT: 9,
  MOUTH_RIGHT: 10,
  LEFT_SHOULDER: 11,
  RIGHT_SHOULDER: 12,
  LEFT_ELBOW: 13,
  RIGHT_ELBOW: 14,
  LEFT_WRIST: 15,
  RIGHT_WRIST: 16,
  LEFT_PINKY: 17,
  RIGHT_PINKY: 18,
  LEFT_INDEX: 19,
  RIGHT_INDEX: 20,
  LEFT_THUMB: 21,
  RIGHT_THUMB: 22,
  LEFT_HIP: 23,
  RIGHT_HIP: 24,
  LEFT_KNEE: 25,
  RIGHT_KNEE: 26,
  LEFT_ANKLE: 27,
  RIGHT_ANKLE: 28,
  LEFT_HEEL: 29,
  RIGHT_HEEL: 30,
  LEFT_FOOT_INDEX: 31,
  RIGHT_FOOT_INDEX: 32,
} as const;

export const POSE_LANDMARK_COUNT = 33;

/** Skeleton edges for drawing. */
export const POSE_CONNECTIONS: ReadonlyArray<readonly [number, number]> = [
  [11, 12], [11, 13], [13, 15], [12, 14], [14, 16],
  [11, 23], [12, 24], [23, 24],
  [23, 25], [25, 27], [27, 29], [29, 31], [27, 31],
  [24, 26], [26, 28], [28, 30], [30, 32], [28, 32],
];

/** MediaPipe hand landmark indices. */
export const HAND = {
  WRIST: 0,
  THUMB_CMC: 1,
  THUMB_MCP: 2,
  THUMB_IP: 3,
  THUMB_TIP: 4,
  INDEX_MCP: 5,
  INDEX_PIP: 6,
  INDEX_DIP: 7,
  INDEX_TIP: 8,
  MIDDLE_MCP: 9,
  MIDDLE_PIP: 10,
  MIDDLE_DIP: 11,
  MIDDLE_TIP: 12,
  RING_MCP: 13,
  RING_PIP: 14,
  RING_DIP: 15,
  RING_TIP: 16,
  PINKY_MCP: 17,
  PINKY_PIP: 18,
  PINKY_DIP: 19,
  PINKY_TIP: 20,
} as const;

export const HAND_LANDMARK_COUNT = 21;

export const HAND_CONNECTIONS: ReadonlyArray<readonly [number, number]> = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [17, 18], [18, 19], [19, 20],
  [0, 17],
];

/** A single detected body, before tracking assigns it an identity. */
export interface RawPose {
  landmarks: Landmark[];
  /** World-space landmarks in metres, origin at hip centre. Useful for scale. */
  worldLandmarks: Landmark[];
}

/** A single detected hand. */
export interface RawHand {
  landmarks: Landmark[];
  handedness: 'Left' | 'Right';
  score: number;
}

/** What the worker posts back each inference frame. */
export interface VisionFrame {
  poses: RawPose[];
  hands: RawHand[];
  /** performance.now() at capture time, for latency measurement. */
  captureTime: number;
  /** ms spent inside MediaPipe. */
  inferenceMs: number;
  frameId: number;
}

export type VisionMode = 'pose' | 'hands' | 'both';

export interface VisionConfig {
  mode: VisionMode;
  numPoses: number;
  numHands: number;
  /**
   * Which pose landmarker to run.
   *
   * lite  — fastest, lowest landmark accuracy. Fine for presence detection.
   * full  — noticeably steadier landmarks for roughly 2x the inference cost.
   * heavy — steadiest, and the slowest by a wide margin.
   *
   * Accuracy here is not cosmetic: every gesture threshold in the app is
   * divided by `scale.unit`, which is computed FROM these landmarks, so a
   * jittery model moves every threshold in every game at once. That is what
   * "tracking is a bit wonky" sounds like from the other side.
   */
  poseModel: 'lite' | 'full' | 'heavy';
}

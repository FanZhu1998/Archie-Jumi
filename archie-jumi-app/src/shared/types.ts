export const PET_IDS = ['archie', 'jumi'] as const;
export type PetId = typeof PET_IDS[number];
export const ACTIONS = ['idle', 'walk', 'trot', 'sit', 'groom', 'sleep', 'wake', 'pet', 'carried', 'land', 'pounce', 'eat', 'nose_touch'] as const;
export type Action = typeof ACTIONS[number];
export type Facing = 'left' | 'right';
export interface Point { x: number; y: number }
export interface Size { width: number; height: number }
export interface Personality { playfulness: number; sociability: number; energy: number }
export interface PetPreferences { name: string; visible: boolean; size: number; personality: Personality; position: Point }
export interface Preferences { sound: boolean; volume: number; reducedMotion: boolean; quiet: boolean; launchAtLogin: boolean; shortcut: string; selectedDisplay: string | null; pets: Record<PetId, PetPreferences>;
  /** Kittens notice a resting cursor and may wander over (1.1.0; additive, schema stays 1). */
  curious: boolean }
export interface SavedState { schemaVersion: 1; preferences: Preferences }
export interface DisplayInfo { id: string; label: string; width: number; height: number; scaleFactor: number; primary: boolean }
export interface Bootstrap {
  preferences: Preferences; displays: DisplayInfo[]; scene: Size; generation: number; hidden: boolean; paused: boolean; cursor: Point | null; notices: string[]; version: string; carryOver: SceneCarryOver | null;
  /** Smoke tests only: main scripts the cursor, so hover follows the cursor feed alone and real pointer events never influence it. */
  scriptedCursor: boolean;
}
/** Scene DIP rectangle (also used for interest regions). */
export interface Rect { x: number; y: number; width: number; height: number }
export type InputTarget = PetId | 'toy' | null;
export interface InputModePayload { generation: number; target: InputTarget; capture: boolean }
/** Sent every second: `frames` counts frame-loop ticks since the previous beat; target/capture resync the input report. */
export interface HeartbeatPayload extends InputModePayload { frames: number }
/** Where the renderer wants to be told about the cursor (inflated sprite and toy rectangles). */
export interface InterestPayload { generation: number; rects: Rect[] }
/** Main-process cursor feed: the cursor in scene DIP while it is inside the interest region, then one `inside: false`. */
export type CursorFeedMessage =
  | { generation: number; inside: true; x: number; y: number }
  | { generation: number; inside: false };
export interface ScenePetCarryOver { action: Action; facing: Facing; forcedSleep: boolean }
/** The last scene state a renderer reported, restored by the next overlay generation. */
export interface SceneCarryOver { generation: number; pets: Record<PetId, ScenePetCarryOver> }
export interface DiagnosticsResult { ok: boolean; message: string; entries?: number }
/** A pounce leap: position moves linearly from `from` to `to`; `progress` 0..1; `height` is the apex in DIP (the arc is drawn by the motion layer). */
export interface LeapState { fromX: number; fromY: number; toX: number; toY: number; progress: number; height: number }
/**
 * A dropped treat. `x`/`y` use pet-centre coordinates: it lies on the ground line of a kitten whose centre is at `y`
 * (the renderer adds the foot offset), `z` DIP above it. At most one per kitten.
 */
export interface TreatState { petId: PetId; x: number; y: number; z: number; phase: 'falling' | 'resting' | 'eaten'; elapsed: number }
export interface PetState {
  id: PetId; x: number; y: number; action: Action; actionTime: number; facing: Facing; forcedSleep: boolean; visible: boolean; size: number; target: Point | null;
  /** Current movement speed in DIP/s; 0 when stationary. */
  speed: number;
  leap: LeapState | null;
  /** A held (press-and-hold) pet is in progress. */
  held: boolean;
}
export interface ToyState extends Point { petId: PetId; remaining: number; automatic: boolean; held: boolean }
export interface PairState { kind: 'nose_touch' | 'nap'; phase: 'approach' | 'together'; elapsed: number }
export interface SceneSnapshot { pets: PetState[]; toy: ToyState | null; pair: PairState | null; time: number; quiet: boolean; treats: TreatState[] }
export type PetCommand =
  | { type: 'pet' | 'treat' | 'nap' | 'wake' | 'hide' | 'show'; petId: PetId }
  | { type: 'play'; petId: PetId; automatic?: boolean }
  | { type: 'move' | 'drag-start' | 'drag' | 'drag-end'; petId: PetId; point: Point }
  | { type: 'toy-move'; point: Point; held: boolean }
  | { type: 'end-play' }
  | { type: 'pair'; kind: 'nose_touch' | 'nap' }
  /** Local only (overlay gesture to engine); never accepted from IPC. */
  | { type: 'pet-hold' | 'pet-release'; petId: PetId }
  /** From the main process menus: walk to a scene point (clipped by validCommand). */
  | { type: 'come'; petId: PetId; point: Point };
export interface AtlasFrame { x: number; y: number; w: number; h: number; duration: number }
export interface AnimationClip { frames: AtlasFrame[]; loop: boolean }
export interface HitEllipse { x: number; y: number; rx: number; ry: number }
export interface AnimationPack { formatVersion: 1; id: PetId; name: string; atlas: string; frameWidth: number; frameHeight: number; anchor: Point; hitShapes: HitEllipse[]; animations: Record<Action, Record<Facing, AnimationClip>>; attribution: string; pages?: Partial<Record<Action, { file: string; offsetX: number; offsetY: number }>> }
export type Lifecycle = { type: 'pause' | 'resume' | 'cancel-input'; cursor?: Point | null };
export interface DesktopAdapter {
  /** True when the main process feeds the cursor position (desktop app); the browser preview has no feed. */
  readonly cursorFeed: boolean;
  getBootstrap(): Promise<Bootstrap>;
  savePreferences(patch: Partial<Preferences>): Promise<Bootstrap>;
  sendCommand(command: PetCommand): void;
  setInputMode(payload: InputModePayload): void;
  ready(generation: number): void;
  heartbeat(payload: HeartbeatPayload): void;
  setInterest(payload: InterestPayload): void;
  reportScene(payload: SceneCarryOver): void;
  savePositions(positions: Record<PetId, Point>): void;
  showPetMenu(petId: PetId): void;
  action(action: 'toggle-hidden' | 'show' | 'hide' | 'settings' | 'quit'): void;
  copyDiagnostics(): Promise<DiagnosticsResult>;
  onBootstrap(callback: (state: Bootstrap) => void): () => void;
  onCommand(callback: (command: PetCommand) => void): () => void;
  onLifecycle(callback: (event: Lifecycle) => void): () => void;
  onCursor(callback: (message: CursorFeedMessage) => void): () => void;
}
declare global { interface Window { desktop?: DesktopAdapter } }

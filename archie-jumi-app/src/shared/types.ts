export const PET_IDS = ['archie', 'jumi'] as const;
export type PetId = typeof PET_IDS[number];
export const ACTIONS = ['idle', 'walk', 'trot', 'sit', 'groom', 'sleep', 'wake', 'pet', 'carried', 'land', 'pounce', 'eat', 'nose_touch'] as const;
export type Action = typeof ACTIONS[number];
export type Facing = 'left' | 'right';
export interface Point { x: number; y: number }
export interface Size { width: number; height: number }
export interface Personality { playfulness: number; sociability: number; energy: number }
export interface PetPreferences { name: string; visible: boolean; size: number; personality: Personality; position: Point }
export interface Preferences { sound: boolean; volume: number; reducedMotion: boolean; quiet: boolean; launchAtLogin: boolean; shortcut: string; selectedDisplay: string | null; pets: Record<PetId, PetPreferences> }
export interface SavedState { schemaVersion: 1; preferences: Preferences }
export interface DisplayInfo { id: string; label: string; width: number; height: number; scaleFactor: number; primary: boolean }
export interface Bootstrap { preferences: Preferences; displays: DisplayInfo[]; scene: Size; generation: number; hidden: boolean; paused: boolean; cursor: Point | null; notices: string[]; version: string }
export interface PetState { id: PetId; x: number; y: number; action: Action; actionTime: number; facing: Facing; forcedSleep: boolean; visible: boolean; size: number; target: Point | null }
export interface ToyState extends Point { petId: PetId; remaining: number; automatic: boolean; held: boolean }
export interface PairState { kind: 'nose_touch' | 'nap'; phase: 'approach' | 'together'; elapsed: number }
export interface SceneSnapshot { pets: PetState[]; toy: ToyState | null; pair: PairState | null; time: number; quiet: boolean }
export type PetCommand =
  | { type: 'pet' | 'treat' | 'nap' | 'wake' | 'hide' | 'show'; petId: PetId }
  | { type: 'play'; petId: PetId; automatic?: boolean }
  | { type: 'move' | 'drag-start' | 'drag' | 'drag-end'; petId: PetId; point: Point }
  | { type: 'toy-move'; point: Point; held: boolean }
  | { type: 'end-play' }
  | { type: 'pair'; kind: 'nose_touch' | 'nap' };
export interface AtlasFrame { x: number; y: number; w: number; h: number; duration: number }
export interface AnimationClip { frames: AtlasFrame[]; loop: boolean }
export interface HitEllipse { x: number; y: number; rx: number; ry: number }
export interface AnimationPack { formatVersion: 1; id: PetId; name: string; atlas: string; frameWidth: number; frameHeight: number; anchor: Point; hitShapes: HitEllipse[]; animations: Record<Action, Record<Facing, AnimationClip>>; attribution: string; pages?: Partial<Record<Action, { file: string; offsetX: number; offsetY: number }>> }
export type Lifecycle = { type: 'pause' | 'resume' | 'cancel-input'; cursor?: Point | null };
export interface DesktopAdapter {
  getBootstrap(): Promise<Bootstrap>;
  savePreferences(patch: Partial<Preferences>): Promise<Bootstrap>;
  sendCommand(command: PetCommand): void;
  setInputMode(payload: { generation: number; target: PetId | 'toy' | null; capture: boolean }): void;
  ready(generation: number): void;
  heartbeat(generation: number): void;
  savePositions(positions: Record<PetId, Point>): void;
  showPetMenu(petId: PetId): void;
  action(action: 'toggle-hidden' | 'show' | 'hide' | 'settings' | 'quit'): void;
  onBootstrap(callback: (state: Bootstrap) => void): () => void;
  onCommand(callback: (command: PetCommand) => void): () => void;
  onLifecycle(callback: (event: Lifecycle) => void): () => void;
}
declare global { interface Window { desktop?: DesktopAdapter } }

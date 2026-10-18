import { useEffect, useRef, useState } from 'react';
import type { CSSProperties, FormEvent, ReactNode } from 'react';
import type { Bootstrap, DesktopAdapter, Personality, PetCommand, PetId, PetPreferences, Preferences } from '../shared/types';
import { createPreviewAdapter } from '../preview/adapter';
import { PetPortrait } from './PetPortrait';
import './styles.css';

let fallbackAdapter: DesktopAdapter | undefined;
type IconName = 'paw' | 'heart' | 'spark' | 'moon' | 'sun' | 'eye' | 'hidden' | 'settings' | 'sound' | 'monitor' | 'arrow' | 'check' | 'close' | 'edit' | 'leaf';
const iconPaths: Record<IconName, string> = {
  paw: 'M7.5 13.5c1-1 1.5-3 4.5-3s3.5 2 4.5 3c3 3 1.5 6-1 5.5-2-.5-5-.5-7 0-2.5.5-4-2.5-1-5.5ZM7 5.5c0 2-2.5 2-2.5 0S7 3.5 7 5.5ZM12 3.5c0 2.5-3 2.5-3 0s3-2.5 3 0ZM16.5 4c0 2.5-3 2.5-3 0s3-2.5 3 0ZM20 7c0 2-2.5 2-2.5 0s2.5-2 2.5 0Z',
  heart: 'M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8L12 21l8.8-8.6a5.5 5.5 0 0 0 0-7.8Z',
  spark: 'm12 2 2.5 7.5L22 12l-7.5 2.5L12 22l-2.5-7.5L2 12l7.5-2.5L12 2Z',
  moon: 'M20.8 13a8.8 8.8 0 0 1-9.8-9.8A9 9 0 1 0 20.8 13Z',
  sun: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8ZM12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5',
  eye: 'M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Zm10-3a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z',
  hidden: 'm3 3 18 18M10 5.2c.6-.1 1.3-.2 2-.2 6.5 0 10 7 10 7s-1.3 2.6-3.8 4.6M6.5 6.5C3.5 8.5 2 12 2 12s3.5 7 10 7c1.8 0 3.4-.5 4.8-1.2M10 10a3 3 0 0 0 4 4',
  settings: 'M4 7h16M4 17h16M8 4v6m8 4v6',
  sound: 'M11 4 6 8H3v8h3l5 4V4Zm4 4a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14',
  monitor: 'M3 3h18v13H3V3Zm5 18h8m-4-5v5',
  arrow: 'M12 19V5m-6 6 6-6 6 6',
  check: 'm5 12 4 4L19 6',
  close: 'm6 6 12 12M6 18 18 6',
  edit: 'm16 3 5 5-12 12-6 1 1-6L16 3Zm-2 2 5 5',
  leaf: 'M20 3C8 1 2 8 5 15c3 7 15 4 15-12ZM4 21l11-11',
};

function Icon({ name, className = '' }: { name: IconName; className?: string }) {
  return <svg className={`icon ${className}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={iconPaths[name]} /></svg>;
}

function Toggle({ checked, onChange, label, description, disabled = false }: { checked: boolean; onChange: (value: boolean) => void; label: string; description?: string; disabled?: boolean }) {
  return <label className={`toggle-row${disabled ? ' is-disabled' : ''}`}>
    <span className="toggle-copy"><span className="control-label">{label}</span>{description && <span className="control-hint">{description}</span>}</span>
    <span className="switch"><input type="checkbox" checked={checked} onChange={event => onChange(event.target.checked)} disabled={disabled} /><span className="switch-track" aria-hidden="true" /></span>
  </label>;
}

function Slider({ label, value, min, max, step, display, onChange, disabled }: { label: string; value: number; min: number; max: number; step: number; display: string; onChange: (value: number) => void; disabled?: boolean }) {
  return <label className={`slider-control${disabled ? ' is-disabled' : ''}`}>
    <span className="slider-label"><span>{label}</span><output>{display}</output></span>
    <input type="range" aria-label={label} aria-valuetext={display} min={min} max={max} step={step} value={value} onChange={event => onChange(Number(event.target.value))} disabled={disabled} style={{ '--progress': `${(value - min) / (max - min) * 100}%` } as CSSProperties} />
  </label>;
}

function PetCard({ id, pet, hidden, onChange, command, move }: { id: PetId; pet: PetPreferences; hidden: boolean; onChange: (patch: Partial<PetPreferences>) => void; command: (command: PetCommand, message: string) => void; move: (id: PetId, dx: number, dy: number) => void }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(pet.name);
  const [automatic, setAutomatic] = useState(true);
  const nameInput = useRef<HTMLInputElement>(null);
  const disabled = !pet.visible || hidden;
  useEffect(() => { if (!editing) setName(pet.name); }, [pet.name, editing]);
  useEffect(() => { if (editing) { nameInput.current?.focus(); nameInput.current?.select(); } }, [editing]);
  const saveName = (event: FormEvent) => { event.preventDefault(); const next = name.trim(); if (next) onChange({ name: next }); else setName(pet.name); setEditing(false); };
  const changePersonality = (key: keyof Personality, value: number) => onChange({ personality: { ...pet.personality, [key]: value } });

  return <article className={`pet-card ${id}${!pet.visible ? ' resting-card' : ''}`} id={`pet-${id}`}>
    <div className="pet-card-top"><span className="pet-type">{id === 'archie' ? 'GRAY & WHITE' : 'ORANGE TABBY'}</span><button className={`visibility-pill${pet.visible ? ' active' : ''}`} onClick={() => onChange({ visible: !pet.visible })} aria-pressed={pet.visible} aria-label={`${pet.visible ? 'Hide' : 'Show'} ${pet.name}`}><span className="status-dot" />{pet.visible ? 'Here with you' : 'Taking a break'}</button></div>
    <PetPortrait id={id} name={pet.name} />
    <div className="pet-card-body">
      {editing ? <form className="name-form" onSubmit={saveName}><label className="sr-only" htmlFor={`${id}-name`}>Name for {pet.name}</label><input id={`${id}-name`} ref={nameInput} value={name} maxLength={32} onChange={event => setName(event.target.value)} onKeyDown={event => { if (event.key === 'Escape') { setEditing(false); setName(pet.name); } }} /><button className="icon-button" type="submit" aria-label="Save name"><Icon name="check" /></button><button className="icon-button" type="button" onClick={() => setEditing(false)} aria-label="Cancel name edit"><Icon name="close" /></button></form> : <div className="pet-title"><h2>{pet.name}</h2><button className="icon-button edit-name" onClick={() => setEditing(true)} aria-label={`Edit ${pet.name}'s name`}><Icon name="edit" /></button></div>}
      <p className="pet-description">{id === 'archie' ? 'Little white paws. A quietly curious heart.' : 'A little sunshine, with a playful streak.'}</p>
      <div className="pet-actions" aria-label={`Interact with ${pet.name}`}>
        <button className="action-button" disabled={disabled} onClick={() => command({ type: 'pet', petId: id }, `A little affection for ${pet.name}.`)}><Icon name="heart" />Pet</button>
        <button className="action-button" disabled={disabled} onClick={() => command({ type: 'treat', petId: id }, `A tiny treat for ${pet.name}.`)}><Icon name="paw" />Treat</button>
        <button className="action-button play-button" disabled={disabled} onClick={() => command({ type: 'play', petId: id, automatic }, `${pet.name}'s ${automatic ? 'automatic ' : ''}playtime has started.`)}><Icon name="spark" />Play</button>
      </div>
      <div className="pet-secondary-actions"><label className="small-checkbox"><input type="checkbox" checked={automatic} onChange={event => setAutomatic(event.target.checked)} />Automatic toy</label><span className="sleep-actions"><button disabled={disabled} onClick={() => command({ type: 'nap', petId: id }, `Sweet dreams, ${pet.name}.`)}><Icon name="moon" />Nap</button><button disabled={disabled} onClick={() => command({ type: 'wake', petId: id }, `Rise and stretch, ${pet.name}.`)}><Icon name="sun" />Wake</button></span></div>
      <details className="pet-tuning"><summary><span><Icon name="settings" />Personality & size</span><span className="details-chevron" aria-hidden="true">⌄</span></summary><div className="tuning-content">
        <Slider label="Size" value={pet.size} min={96} max={192} step={8} display={`${pet.size} px`} onChange={size => onChange({ size })} />
        <Slider label="Playfulness" value={pet.personality.playfulness} min={0} max={1} step={0.05} display={pet.personality.playfulness < 0.35 ? 'Easygoing' : pet.personality.playfulness > 0.65 ? 'Mischievous' : 'Curious'} onChange={value => changePersonality('playfulness', value)} />
        <Slider label="Sociability" value={pet.personality.sociability} min={0} max={1} step={0.05} display={pet.personality.sociability < 0.35 ? 'Independent' : pet.personality.sociability > 0.65 ? 'Cuddly' : 'Friendly'} onChange={value => changePersonality('sociability', value)} />
        <Slider label="Energy" value={pet.personality.energy} min={0} max={1} step={0.05} display={pet.personality.energy < 0.35 ? 'Sleepy' : pet.personality.energy > 0.65 ? 'Bouncy' : 'Content'} onChange={value => changePersonality('energy', value)} />
      </div></details>
      <div className="reposition-row"><span><span className="control-label">A little nudge</span><span className="control-hint">Move {pet.name} around the screen</span></span><div className="direction-buttons" aria-label={`Move ${pet.name}`}><button aria-label={`Move ${pet.name} left`} disabled={disabled} onClick={() => move(id, -1, 0)}><Icon name="arrow" className="point-left" /></button><button aria-label={`Move ${pet.name} up`} disabled={disabled} onClick={() => move(id, 0, -1)}><Icon name="arrow" /></button><button aria-label={`Move ${pet.name} down`} disabled={disabled} onClick={() => move(id, 0, 1)}><Icon name="arrow" className="point-down" /></button><button aria-label={`Move ${pet.name} right`} disabled={disabled} onClick={() => move(id, 1, 0)}><Icon name="arrow" className="point-right" /></button></div></div>
    </div>
  </article>;
}

function SectionTitle({ icon, title, children }: { icon: IconName; title: string; children?: ReactNode }) {
  return <div className="section-heading"><span className="section-icon"><Icon name={icon} /></span><div><h2>{title}</h2>{children && <p>{children}</p>}</div></div>;
}

export function App({ adapter: provided }: { adapter?: DesktopAdapter }) {
  const [adapter] = useState(() => provided ?? window.desktop ?? (fallbackAdapter ??= createPreviewAdapter()));
  const [state, setState] = useState<Bootstrap | null>(null);
  const stateRef = useRef<Bootstrap | null>(null);
  const pending = useRef(0);
  const saveQueue = useRef<Promise<unknown>>(Promise.resolve());
  const [error, setError] = useState('');
  const [toast, setToast] = useState('');
  const [shortcut, setShortcut] = useState('');
  const [shortcutDirty, setShortcutDirty] = useState(false);
  const preview = !window.desktop;

  const accept = (next: Bootstrap) => {
    const value = pending.current > 0 && stateRef.current ? { ...next, preferences: stateRef.current.preferences } : next;
    stateRef.current = value;
    setState(value);
  };
  useEffect(() => {
    let live = true;
    const unsubscribe = adapter.onBootstrap(next => { if (live) accept(next); });
    void adapter.getBootstrap().then(next => { if (live) accept(next); }).catch(() => { if (live) setError('The companions could not load. Close and reopen this window to try again.'); });
    return () => { live = false; unsubscribe(); };
  }, [adapter]);
  useEffect(() => { if (state && !shortcutDirty) setShortcut(state.preferences.shortcut); }, [state?.preferences.shortcut, shortcutDirty]);
  useEffect(() => { if (!toast) return; const timer = window.setTimeout(() => setToast(''), 4200); return () => window.clearTimeout(timer); }, [toast]);

  const save = (patch: Partial<Preferences>) => {
    const current = stateRef.current;
    if (!current) return;
    const next = { ...current, preferences: { ...current.preferences, ...patch } };
    stateRef.current = next;
    setState(next);
    pending.current += 1;
    saveQueue.current = saveQueue.current.catch(() => {}).then(() => adapter.savePreferences(patch)).then(result => {
      pending.current -= 1;
      accept(result);
      setError('');
    }, () => {
      pending.current -= 1;
      setError('That setting could not be saved. Please try again.');
      if (pending.current === 0) void adapter.getBootstrap().then(accept).catch(() => {});
    });
  };
  const updatePet = (id: PetId, patch: Partial<PetPreferences>) => {
    const preferences = stateRef.current?.preferences;
    if (!preferences) return;
    save({ pets: { ...preferences.pets, [id]: { ...preferences.pets[id], ...patch } } });
  };
  const command = (value: PetCommand, message: string) => { adapter.sendCommand(value); setToast(message); };
  const move = (id: PetId, dx: number, dy: number) => {
    const current = stateRef.current;
    if (!current) return;
    const pet = current.preferences.pets[id];
    const { width, height } = current.scene;
    const insetX = Math.min(width / 2, pet.size * 0.62 + 8);
    const insetY = Math.min(height / 2, pet.size * 0.55 + 8);
    const point = { x: Math.max(insetX, Math.min(width - insetX, (pet.position.x + dx * 0.04) * width)), y: Math.max(insetY, Math.min(height - insetY, (pet.position.y + dy * 0.04) * height)) };
    updatePet(id, { position: { x: point.x / width, y: point.y / height } });
    command({ type: 'move', petId: id, point }, `${pet.name} moved ${dx < 0 ? 'left' : dx > 0 ? 'right' : dy < 0 ? 'up' : 'down'}.`);
  };

  if (!state) return <main className="loading-screen"><span className="brand-mark"><Icon name="paw" /></span><h1>Archie & Jumi</h1><p role="status">{error || 'Making a little room for your companions…'}</p></main>;
  const preferences = state.preferences;
  const bothVisible = preferences.pets.archie.visible && preferences.pets.jumi.visible && !state.hidden && !preferences.quiet;
  const visibleCount = Number(preferences.pets.archie.visible) + Number(preferences.pets.jumi.visible);

  return <main className={`companion-app${preferences.reducedMotion ? ' reduced-motion' : ''}`}>
    <header className="app-header"><div className="brand"><span className="brand-mark"><Icon name="paw" /></span><span className="brand-wordmark">YOUR LITTLE COMPANIONS</span></div><span className="local-label"><span />At home, on your desktop</span></header>
    <section className="welcome"><div><div className="eyebrow">A LITTLE COMPANY, EVERY DAY</div><h1>Archie <span>&</span> Jumi<span className="title-dot">.</span></h1><p>Small paws. Soft purrs. A happier corner of your day.</p></div><button className={`primary-button visibility-button${state.hidden ? ' show-pets' : ''}`} onClick={() => adapter.action('toggle-hidden')}><Icon name={state.hidden ? 'eye' : 'hidden'} />{state.hidden ? 'Show companions' : 'Hide companions'}</button></section>
    {preview && <div className="preview-banner"><span><strong>Browser playground</strong> Your settings and playtime sync across preview tabs. Desktop overlay, shortcuts and startup are available in the Windows app.</span><a href="?view=overlay" target="archie-jumi-playground">Open playground <span aria-hidden="true">↗</span></a></div>}
    {error && <div className="notice error-notice" role="alert">{error}<button aria-label="Dismiss error" onClick={() => setError('')}><Icon name="close" /></button></div>}
    {state.notices.length > 0 && <div className="notice-list" role="status">{state.notices.map((notice, index) => <p className="notice" key={`${notice}-${index}`}>{notice}</p>)}</div>}
    <div className="pets-section-label"><h2>Meet your companions</h2><span><span className={`status-dot${state.hidden || !visibleCount ? ' muted' : ''}`} />{state.hidden ? 'Resting out of sight' : `${visibleCount === 2 ? 'Both' : visibleCount === 1 ? 'One companion' : 'No companions'} on your ${preview ? 'playground' : 'desktop'}`}</span></div>
    <section className="pet-grid" aria-label="Your kittens">{(['archie', 'jumi'] as const).map(id => <PetCard key={id} id={id} pet={preferences.pets[id]} hidden={state.hidden || preferences.quiet} onChange={patch => updatePet(id, patch)} command={command} move={move} />)}</section>
    <section className="together-card"><div className="together-description"><span className="together-icon"><Icon name="heart" /></span><div><h2>Better together</h2><p>A shared little moment for your favorite pair.</p></div></div><div className="together-actions"><button className="secondary-button" disabled={!bothVisible} onClick={() => command({ type: 'pair', kind: 'nose_touch' }, 'A little nose-to-nose hello.')}><Icon name="heart" />Nose boop</button><button className="secondary-button" disabled={!bothVisible} onClick={() => command({ type: 'pair', kind: 'nap' }, 'A cozy nap together.')}><Icon name="moon" />Nap together</button><button className="text-button" onClick={() => command({ type: 'end-play' }, 'Playtime ended. Back to a gentle pace.')}><Icon name="close" />End play</button></div></section>
    <div className="settings-grid">
      <section className="settings-card"><SectionTitle icon="leaf" title="Your calm corner">Make their company feel just right.</SectionTitle><div className="settings-body">
        <Toggle checked={preferences.quiet} onChange={quiet => save({ quiet })} label="Quiet mode" description="Pause play and roaming while both kittens rest." />
        <Toggle checked={preferences.sound} onChange={sound => save({ sound })} label="Little sounds" description="Soft, gentle purrs. Off until you choose." />
        <div className="volume-control"><Icon name="sound" /><Slider label="Volume" value={preferences.volume} min={0} max={1} step={0.05} display={`${Math.round(preferences.volume * 100)}%`} onChange={volume => save({ volume })} disabled={!preferences.sound} /></div>
        <Toggle checked={preferences.reducedMotion} onChange={reducedMotion => save({ reducedMotion })} label="Gentler motion" description="Reduce movement and animated flourishes." />
      </div></section>
      <section className="settings-card"><SectionTitle icon="monitor" title="A place on your desktop">A few small details, made yours.</SectionTitle><div className="settings-body desktop-settings">
        <label className="field-label">Their screen<select value={preferences.selectedDisplay ?? state.displays.find(display => display.primary)?.id ?? state.displays[0]?.id ?? ''} onChange={event => save({ selectedDisplay: event.target.value })}>{state.displays.map(display => <option key={display.id} value={display.id}>{display.label}{display.primary && !preview ? ' · Primary' : ''}</option>)}</select><span className="control-hint">Both kittens stay together on the selected screen.</span></label>
        <form className="shortcut-form" onSubmit={event => { event.preventDefault(); if (!shortcut.trim()) { setError('Enter a keyboard shortcut before saving.'); return; } save({ shortcut: shortcut.trim() }); setShortcutDirty(false); setToast('Hide / show shortcut saved.'); }}><label className="field-label" htmlFor="visibility-shortcut">Hide / show shortcut</label><div className="shortcut-input"><input id="visibility-shortcut" value={shortcut} onChange={event => { setShortcut(event.target.value); setShortcutDirty(true); }} disabled={preview} spellCheck={false} autoComplete="off" aria-describedby="shortcut-hint" /><button className="small-button" disabled={preview || !shortcutDirty} type="submit">Save</button></div><span className="control-hint" id="shortcut-hint">{preview ? 'Global shortcuts are available in the desktop app.' : 'For example: Control+Alt+Shift+P. Use a combination other apps do not use.'}</span></form>
        <Toggle checked={preferences.launchAtLogin} onChange={launchAtLogin => save({ launchAtLogin })} label="Start the day together" description="Launch when you sign in to Windows." disabled={preview} />
      </div></section>
    </div>
    <footer className="app-footer"><span><Icon name="heart" />Made for Archie & Jumi. No chores. Just company.</span><span>Saved on this device <span className="footer-dot">·</span> v{state.version}</span></footer>
    <div className={`toast${toast ? ' visible' : ''}`} role="status" aria-live="polite" aria-atomic="true">{toast && <><Icon name="check" /><span>{toast}</span></>}</div>
  </main>;
}

export default App;

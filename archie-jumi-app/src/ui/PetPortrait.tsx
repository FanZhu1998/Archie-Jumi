import { useState } from 'react';
import type { PetId } from '../shared/types';

export function PetPortrait({ id, name }: { id: PetId; name: string }) {
  const [failed, setFailed] = useState(false);
  const portraitUrl = new URL(`pets/${id}/portrait.png`, document.baseURI).href;
  const initials = name.trim().split(/\s+/).slice(0, 2).map(part => Array.from(part)[0] ?? '').join('').toLocaleUpperCase();

  return <div className={`pet-portrait ${id}`} role="img" aria-label={failed ? `${name}, portrait unavailable` : `${name}, ${id === 'archie' ? 'a gray and white kitten' : 'an orange tabby kitten'}`}>
    {!failed && <img className="portrait-image" src={portraitUrl} alt="" aria-hidden="true" onError={() => setFailed(true)} />}
    {failed && <span className="portrait-initials" aria-hidden="true">{initials || id[0].toUpperCase()}</span>}
  </div>;
}

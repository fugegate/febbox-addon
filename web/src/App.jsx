import { useState, useCallback } from 'react';
import {
  Key,
  ShieldCheck,
  Gauge,
  Sliders,
  LinkSimple,
  Eye as EyeIcon,
  EyeSlash,
  Check,
  Warning,
  Copy as CopyIcon,
  Play,
  CaretRight,
  Spinner as SpinnerIcon,
} from '@phosphor-icons/react';

const Icon = {
  Key: (p) => <Key weight="bold" {...p} />,
  Shield: (p) => <ShieldCheck weight="bold" {...p} />,
  Gauge: (p) => <Gauge weight="bold" {...p} />,
  Sliders: (p) => <Sliders weight="bold" {...p} />,
  Link: (p) => <LinkSimple weight="bold" {...p} />,
  Eye: (p) => <EyeIcon weight="bold" {...p} />,
  EyeOff: (p) => <EyeSlash weight="bold" {...p} />,
  Check: (p) => <Check weight="bold" {...p} />,
  Alert: (p) => <Warning weight="bold" {...p} />,
  Copy: (p) => <CopyIcon weight="bold" {...p} />,
  Play: (p) => <Play weight="fill" {...p} />,
  Chevron: (p) => <CaretRight weight="bold" {...p} />,
  Spinner: (p) => <SpinnerIcon weight="bold" className="spin" {...p} />,
};

function formatMB(mb) {
  const units = ['MB', 'GB', 'TB', 'PB'];
  let value = mb;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  const rounded = value >= 100 ? Math.round(value) : Math.round(value * 100) / 100;
  return `${rounded} ${units[i]}`;
}

function StatusLine({ status }) {
  if (!status) return null;
  const IconEl = status.kind === 'ok' ? Icon.Check : status.kind === 'err' ? Icon.Alert : Icon.Spinner;
  return (
    <div className={`status show ${status.kind}`}>
      <IconEl className="status-icon" />
      <span>{status.text}</span>
    </div>
  );
}

// Example previews matching the exact backend formatting in
// src/stremio/routes.js formatNameAndTitle() / src/stremio/displayMode.js
// — kept here purely as illustrative copy, not read by the backend.
const DISPLAY_MODES = [
  {
    value: 'minimal',
    label: 'Minimal',
    blurb: 'Just the resolution. Nothing else.',
    preview: { name: '4K', title: '' },
  },
  {
    value: 'balanced',
    label: 'Balanced',
    blurb: 'Clean episode/movie title, resolution only as the detail.',
    preview: { name: 'The Dark Knight', title: '4K' },
  },
  {
    value: 'standard',
    label: 'Standard',
    blurb: 'Clean title, plus size/HDR/audio — never the raw filename.',
    preview: { name: 'The Dark Knight', title: '4K\n1.1 GB · HDR · Atmos' },
    recommended: true,
  },
  {
    value: 'detailed',
    label: 'Detailed',
    blurb: 'Everything, including the original release filename.',
    preview: {
      name: 'FebBox 2160p',
      title: 'The.Dark.Knight.2008.2160p.x265\n1.1 GB · HDR · Atmos',
    },
  },
];

function DisplayModePicker({ value, onChange }) {
  return (
    <div className="mode-grid" role="radiogroup" aria-label="Stream display format">
      {DISPLAY_MODES.map((mode) => (
        <label key={mode.value} className={`mode-card ${value === mode.value ? 'selected' : ''}`}>
          <input
            type="radio"
            name="displayMode"
            value={mode.value}
            checked={value === mode.value}
            onChange={() => onChange(mode.value)}
          />
          <div className="mode-card-head">
            <span className="mode-card-label">{mode.label}</span>
            {mode.recommended && <span className="mode-card-badge">Recommended</span>}
          </div>
          <p className="mode-card-blurb">{mode.blurb}</p>
          <div className="mode-preview">
            <div className="mode-preview-name">{mode.preview.name}</div>
            {mode.preview.title && (
              <div className="mode-preview-title">
                {mode.preview.title.split('\n').map((line, i) => (
                  <div key={i}>{line}</div>
                ))}
              </div>
            )}
          </div>
        </label>
      ))}
    </div>
  );
}

function Step({ last, title, sub, children }) {
  return (
    <div className={`step ${last ? 'step-last' : ''}`}>
      <div className="step-card">
        <div className="step-head">
          <h2>{title}</h2>
          {sub && <p className="card-sub">{sub}</p>}
        </div>
        {children}
      </div>
    </div>
  );
}

export default function App() {
  const [token, setToken] = useState('');
  const [showToken, setShowToken] = useState(false);
  const [playbackMode, setPlaybackMode] = useState('direct');
  const [displayMode, setDisplayMode] = useState('standard');
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [tokenHelpOpen, setTokenHelpOpen] = useState(false);
  const [status, setStatus] = useState(null);
  const [validating, setValidating] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [result, setResult] = useState(null); // { url, playbackMode, displayMode }
  const [copied, setCopied] = useState(false);

  const validate = useCallback(async () => {
    const t = token.trim();
    if (!t) return setStatus({ kind: 'err', text: 'Paste your FebBox token first.' });
    setValidating(true);
    setStatus({ kind: 'pending', text: 'Validating…' });
    try {
      const resp = await fetch('/api/validate-token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: t }),
      });
      const data = await resp.json();
      if (data.isValid) {
        setStatus({
          kind: 'ok',
          text: `Token valid — ${data.quota ? formatMB(data.quota.remainingMB) + ' remaining' : 'quota unknown'}`,
        });
      } else {
        setStatus({ kind: 'err', text: data.message || 'Token invalid.' });
      }
    } catch (e) {
      setStatus({ kind: 'err', text: 'Validation request failed — check your connection and try again.' });
    } finally {
      setValidating(false);
    }
  }, [token]);

  const install = useCallback(async () => {
    const t = token.trim();
    if (!t) return setStatus({ kind: 'err', text: 'Paste your FebBox token first.' });
    setInstalling(true);
    setResult(null);
    setStatus({ kind: 'pending', text: 'Generating install link…' });
    try {
      const resp = await fetch('/api/create-config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: t, playbackMode, displayMode }),
      });
      const data = await resp.json();
      if (data.configToken) {
        const url = `${window.location.origin}/${data.configToken}/manifest.json`;
        setResult({ url, playbackMode: data.playbackMode, displayMode: data.displayMode });
        setStatus({ kind: 'ok', text: `Ready (${data.playbackMode} · ${data.displayMode}).` });
      } else {
        setStatus({ kind: 'err', text: data.error || 'Failed to create config.' });
      }
    } catch (e) {
      setStatus({ kind: 'err', text: 'Request failed — check your connection and try again.' });
    } finally {
      setInstalling(false);
    }
  }, [token, playbackMode, displayMode]);

  const copy = useCallback(async () => {
    if (!result) return;
    try {
      await navigator.clipboard.writeText(result.url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch (e) {
      // Clipboard API unavailable — no-op, the URL box is still selectable/readable.
    }
  }, [result]);

  return (
    <div className="wrap">
      <div className="brand">
        <img src="/assets/icon.png" alt="FebBox Addon" />
        <h1>FebBox Addon</h1>
      </div>
      <p className="tagline">
        A Stremio addon that streams movies &amp; TV shows straight from FebBox's catalog, using your own
        account's access.
      </p>

      <div className="notice-row">
        <div className="notice amber">
          <Icon.Shield className="notice-icon" />
          <div>
            <strong>Your FebBox token is an account credential.</strong>
            <p>
              Treat it like a password. It's encrypted before it ever appears in your install URL, and it's never
              sent to analytics or any third party. See <code>docs/SECURITY.md</code>.
            </p>
          </div>
        </div>
        <div className="notice blue">
          <Icon.Gauge className="notice-icon" />
          <div>
            <strong>Two things to know before you install</strong>
            <ul>
              <li>Streams use FebBox's original ("ORG") files by default — full, untranscoded source files, sometimes 40GB+ per movie.</li>
              <li>Every byte streamed counts against <em>your own</em> FebBox quota. This addon never proxies your video traffic.</li>
            </ul>
          </div>
        </div>
      </div>

      <div className="stepper">
        <Step title="Your FebBox token" sub="Grants the addon access to your own account's catalog and quota.">
          <div className="field">
            <div className="token-row">
              <Icon.Key className="token-icon" />
              <input
                id="token"
                aria-label="FebBox Token"
                type={showToken ? 'text' : 'password'}
                placeholder="Paste your FebBox token"
                autoComplete="off"
                value={token}
                onChange={(e) => setToken(e.target.value)}
              />
              <button type="button" className="toggle-visibility" onClick={() => setShowToken((v) => !v)}>
                {showToken ? <Icon.EyeOff /> : <Icon.Eye />}
              </button>
            </div>
            <div className="token-field-footer">
              <button type="button" className="link-btn" disabled={validating} onClick={validate}>
                {validating && <Icon.Spinner />}
                {validating ? 'Validating…' : 'Check token validity'}
              </button>
              <StatusLine status={status} />
            </div>
          </div>

          <details className="advanced" open={tokenHelpOpen} onToggle={(e) => setTokenHelpOpen(e.target.open)}>
            <summary>
              <Icon.Chevron className="chev" />
              Where do I find my FebBox token?
            </summary>
            <div className="inner">
              <ol className="steps">
                <li>Go to <a href="https://www.febbox.com" target="_blank" rel="noopener noreferrer">febbox.com</a> and log in (or create a free account).</li>
                <li>Open your browser's developer tools — right-click the page → <strong>Inspect</strong> (or press F12).</li>
                <li>Go to the <strong>Application</strong> tab (Chrome/Edge) or <strong>Storage</strong> tab (Firefox) → <strong>Cookies</strong> → <code>https://www.febbox.com</code>.</li>
                <li>Find the cookie named <code>ui</code> and copy its <strong>Value</strong> — that long string is your token.</li>
                <li>Paste it into the field above. Nothing else on that page is needed.</li>
              </ol>
            </div>
          </details>
        </Step>

        <Step title="Customize your streams" sub="Optional — how much detail each stream shows in Stremio. Purely cosmetic, sensible defaults are pre-selected.">
          <div className="field">
            <DisplayModePicker value={displayMode} onChange={setDisplayMode} />
          </div>

          <details className="advanced" open={advancedOpen} onToggle={(e) => setAdvancedOpen(e.target.open)}>
            <summary>
              <Icon.Chevron className="chev" />
              Advanced: playback mode
            </summary>
            <div className="inner">
              <div className="field">
                <label htmlFor="playbackMode">Playback mode</label>
                <select id="playbackMode" value={playbackMode} onChange={(e) => setPlaybackMode(e.target.value)}>
                  <option value="direct">Direct (recommended)</option>
                  <option value="experimental-hls">Experimental HLS only</option>
                  <option value="both">Both (direct + experimental HLS)</option>
                </select>
                <p className="hint">
                  {playbackMode === 'direct' &&
                    "Only FebBox's original file — verified to play and seek correctly."}
                  {playbackMode === 'experimental-hls' &&
                    "Only FebBox's transcoded HLS quality tiers. Known to break seeking in Stremio's web player — use only if you understand this limitation."}
                  {playbackMode === 'both' &&
                    "The safe direct option plus HLS quality tiers as extra choices. HLS entries are clearly marked and may not seek correctly."}
                </p>
              </div>
            </div>
          </details>
        </Step>

        <Step last title="Install" sub="Generates a per-user install link — nothing is installed until you tap it.">
          <div className="actions">
            <button type="button" className="btn-primary btn-block" disabled={installing || !token.trim()} onClick={install}>
              {installing ? <Icon.Spinner /> : <Icon.Link />}
              {installing ? 'Generating…' : 'Generate install link'}
            </button>
          </div>

          {result && (
            <div className="result">
              <div className="result-label">Install URL</div>
              <div className="url-row">
                <div className="url-box">{result.url}</div>
                <button type="button" className={`btn-secondary copy-btn ${copied ? 'copied' : ''}`} onClick={copy}>
                  {copied ? <Icon.Check /> : <Icon.Copy />}
                  {copied ? 'Copied!' : 'Copy'}
                </button>
              </div>
              <a className="btn-primary install-link" href={result.url.replace(/^https?:\/\//, 'stremio://')}>
                <Icon.Play />
                Install in Stremio
              </a>
              <p className="hint">
                The button above opens Stremio directly and prompts to install (works if Stremio is installed on
                this device). Otherwise, paste the URL manually: Addons → the puzzle-piece icon → paste URL →
                Install.
              </p>
            </div>
          )}
        </Step>
      </div>

      <footer>
        FebBox Addon is self-hosted &amp; open-source. See{' '}
        <a href="https://github.com/fugegate/febbox-addon" target="_blank" rel="noopener noreferrer">
          the repo
        </a>{' '}
        for docs.
      </footer>
    </div>
  );
}

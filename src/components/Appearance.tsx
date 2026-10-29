import { Check, Minus, Plus, RotateCcw, Sun, Droplets } from "lucide-react";
import {
  DEFAULT_PREFERENCES,
  THEMES,
  type Preferences,
} from "../lib/preferences";
import { Modal } from "./Modal";

export function Appearance({
  value,
  onChange,
  onClose,
  notice,
}: {
  value: Preferences;
  onChange: (value: Preferences) => void;
  onClose: () => void;
  notice?: { message: string; error: boolean } | null;
}) {
  const patch = (change: Partial<Preferences>) =>
    onChange({ ...value, ...change });
  return (
    <Modal
      title="Make yourself at home."
      subtitle="One theme, across your whole playground."
      onClose={onClose}
      className="appearance-modal"
      notice={notice}
    >
      <section className="settings-section">
        <div className="section-label">COLOR PALETTE</div>
        <div className="theme-options">
          {THEMES.map((theme) => (
            <button
              key={theme.id}
              className={`theme-option ${value.theme === theme.id ? "selected" : ""}`}
              aria-pressed={value.theme === theme.id}
              onClick={() => patch({ theme: theme.id })}
            >
              <div
                className="theme-preview"
                style={{ background: theme.swatches[0] }}
              >
                <div
                  className="theme-mini-rail"
                  style={{ background: theme.swatches[1] }}
                />
                <div className="theme-mini-code">
                  {[3, 2, 4].map((length, i) => (
                    <span
                      key={i}
                      style={{
                        background:
                          theme.swatches[i === 1 ? 2 : 3] || theme.swatches[1],
                        width: `${length * 15}%`,
                      }}
                    />
                  ))}
                </div>
                {value.theme === theme.id && (
                  <span className="theme-check">
                    <Check size={12} />
                  </span>
                )}
              </div>
              <strong>{theme.name}</strong>
              <span>{theme.description}</span>
            </button>
          ))}
        </div>
      </section>
      <section className="settings-section">
        <div className="settings-title">
          <div>
            <h3>
              <Droplets size={16} />
              Surface opacity
            </h3>
            <p>The background blends. Your text stays crisp.</p>
          </div>
          <output className="value-badge" htmlFor="opacity">
            {Math.round(value.opacity * 100)}%
          </output>
        </div>
        <input
          id="opacity"
          aria-label="Surface opacity"
          type="range"
          min="70"
          max="100"
          step="1"
          value={Math.round(value.opacity * 100)}
          onChange={(event) =>
            patch({ opacity: Number(event.target.value) / 100 })
          }
        />
        <div className="range-labels">
          <span>More glass</span>
          <span>Solid</span>
        </div>
        <div className="setting-row">
          <div>
            <strong>Background blur</strong>
            <span>Softens the color field behind each surface.</span>
          </div>
          <button
            role="switch"
            aria-checked={value.blur}
            aria-label="Background blur"
            className={`switch ${value.blur ? "on" : ""}`}
            onClick={() => patch({ blur: !value.blur })}
          >
            <span />
          </button>
        </div>
      </section>
      <section className="settings-section">
        <div className="setting-row">
          <div>
            <strong>Terminal text</strong>
            <span>Changes the live console and command output.</span>
          </div>
          <div className="stepper">
            <button
              aria-label="Decrease terminal font size"
              disabled={value.fontSize <= 12}
              onClick={() => patch({ fontSize: value.fontSize - 1 })}
            >
              <Minus size={14} />
            </button>
            <output>{value.fontSize}px</output>
            <button
              aria-label="Increase terminal font size"
              disabled={value.fontSize >= 20}
              onClick={() => patch({ fontSize: value.fontSize + 1 })}
            >
              <Plus size={14} />
            </button>
          </div>
        </div>
        <div className="setting-row">
          <div>
            <strong>Reduce motion</strong>
            <span>Your system preference is also respected.</span>
          </div>
          <button
            role="switch"
            aria-checked={value.reduceMotion}
            aria-label="Reduce motion"
            className={`switch ${value.reduceMotion ? "on" : ""}`}
            onClick={() => patch({ reduceMotion: !value.reduceMotion })}
          >
            <span />
          </button>
        </div>
      </section>
      <footer className="modal-footer">
        <button
          className="button ghost"
          onClick={() => onChange({ ...DEFAULT_PREFERENCES })}
        >
          <RotateCcw size={14} />
          Reset
        </button>
        <button
          className="button secondary"
          onClick={() => patch({ opacity: 1, blur: false })}
        >
          <Sun size={14} />
          Solid surfaces
        </button>
        <button className="button primary" onClick={onClose}>
          Done
          <Check size={15} />
        </button>
      </footer>
    </Modal>
  );
}

import { useState } from 'react';
import { Button } from '../ui.jsx';
import ModelConfiguration, { modelConfigurationForCatalog, modelConfigurationIsValid } from '../ModelConfiguration.jsx';

export default function LoopSetup({ scan, references, onEnable, busy }) {
  const [model, setModel] = useState(null);
  const [maxLoops, setMaxLoops] = useState(1);
  const [metric, setMetric] = useState('validated_high_critical');
  const [minimum, setMinimum] = useState(1);
  const [targetClass, setTargetClass] = useState('bounty');
  const selection =
    model ||
    (references &&
      modelConfigurationForCatalog(
        {
          model: scan.model,
          model_provider: scan.modelProvider,
          harness: scan.harness,
          thinking_effort: scan.thinkingEffort,
        },
        references.providers,
        references.catalog
      ));
  const valid =
    references &&
    selection &&
    modelConfigurationIsValid(selection, references.providers, references.catalog) &&
    Number.isInteger(Number(maxLoops)) &&
    maxLoops >= 1 &&
    maxLoops <= 10 &&
    Number(minimum) > 0;
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        onEnable({
          max_loops: Number(maxLoops),
          improvement_model: selection,
          metric,
          min_improvement: Number(minimum),
          target_class: targetClass,
        });
      }}
    >
      <fieldset disabled={busy}>
        <p>Analyze this scan after it completes, then propose a new workflow. Every rerun requires your approval.</p>
        <div className="sil-grid">
          <label htmlFor="sil-max">
            Maximum iterations
            <input
              id="sil-max"
              type="number"
              min="1"
              max="10"
              value={maxLoops}
              onChange={(event) => setMaxLoops(event.target.value)}
              required
            />
          </label>
          <label htmlFor="sil-target">
            Target class
            <select id="sil-target" value={targetClass} onChange={(event) => setTargetClass(event.target.value)}>
              <option value="bounty">Bug bounty</option>
              <option value="production">Production</option>
              <option value="lab">Lab</option>
            </select>
          </label>
          <label htmlFor="sil-metric">
            Evaluation metric
            <select
              id="sil-metric"
              value={metric}
              onChange={(event) => {
                setMetric(event.target.value);
                setMinimum(event.target.value === 'confidence' ? 0.01 : 1);
              }}
            >
              <option value="validated_high_critical">Validated high / critical findings</option>
              <option value="confidence">Reviewer confidence</option>
            </select>
          </label>
          <label htmlFor="sil-minimum">
            Minimum improvement
            <input
              id="sil-minimum"
              type="number"
              min={metric === 'confidence' ? 0.01 : 1}
              step={metric === 'confidence' ? 0.01 : 1}
              value={minimum}
              onChange={(event) => setMinimum(event.target.value)}
              required
            />
          </label>
        </div>
        <h3>Improvement model</h3>
        {selection && references ? (
          <ModelConfiguration
            value={selection}
            onChange={setModel}
            providers={references.providers}
            catalog={references.catalog}
            catalogError={references.catalogError}
            disabled={busy}
          />
        ) : (
          <p className="sil-muted">Loading configured models…</p>
        )}
        <p className="sil-muted">
          The selected model analyzes the workflow. Reruns retain the original scan model and target settings.
        </p>
        <Button type="submit" disabled={!valid || ['failed', 'stopped'].includes(scan.status)}>
          Enable for this scan
        </Button>
      </fieldset>
    </form>
  );
}

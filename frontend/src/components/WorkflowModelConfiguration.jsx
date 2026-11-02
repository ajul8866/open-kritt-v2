import ModelConfiguration, {
  THINKING_EFFORTS,
  modelConfigurationForCatalog,
  modelConfigurationIsValid,
} from './ModelConfiguration.jsx';
import { thinkingEffortsForModel } from '../lib/modelProviders.js';
import {
  enableModelOverrides,
  modelOverridesDraft,
  modelSelectionDraft,
  normalizeModelOverrides,
  resolvedModelConfiguration,
} from '../lib/modelOverrides.js';

function postProcessingOverrideEnabled(value = {}) {
  return Boolean(value.post_processing_model_override ?? value.postProcessingModelOverride);
}

export function postProcessingModelConfiguration(value = {}) {
  const override = postProcessingOverrideEnabled(value);
  return {
    model: override ? (value.post_processing_model ?? value.postProcessingModel ?? value.model) : value.model,
    model_provider: override
      ? (value.post_processing_model_provider ?? value.postProcessingModelProvider ?? value.model_provider)
      : value.model_provider,
    harness: override ? (value.post_processing_harness ?? value.postProcessingHarness ?? value.harness) : value.harness,
    thinking_effort:
      value.post_processing_thinking_effort ?? value.postProcessingThinkingEffort ?? value.thinking_effort,
  };
}

export function workflowModelConfigurationForCatalog(current, providers, catalog) {
  const base = modelConfigurationForCatalog(current, providers, catalog);
  const postProcessingModelOverride = postProcessingOverrideEnabled(current);
  const postProcessing = modelConfigurationForCatalog(
    postProcessingModelOverride
      ? postProcessingModelConfiguration({ ...current, post_processing_model_override: true })
      : {
          ...base,
          thinking_effort:
            current?.post_processing_thinking_effort ?? current?.postProcessingThinkingEffort ?? base.thinking_effort,
        },
    providers,
    catalog
  );
  return {
    ...base,
    post_processing_model_override: postProcessingModelOverride,
    post_processing_model: postProcessing.model,
    post_processing_model_provider: postProcessing.model_provider,
    post_processing_harness: postProcessing.harness,
    post_processing_thinking_effort: postProcessing.thinking_effort,
    model_overrides: normalizeModelOverrides(current?.model_overrides ?? current?.modelOverrides, (configuration) =>
      modelConfigurationForCatalog(configuration, providers, catalog)
    ),
  };
}

export function workflowModelConfigurationIsValid(value, depths, providers, catalog) {
  if (!modelConfigurationIsValid(value, providers, catalog)) return false;
  if (!modelConfigurationIsValid(postProcessingModelConfiguration(value), providers, catalog)) return false;
  const overrides = modelOverridesDraft(value?.model_overrides ?? value?.modelOverrides);
  const allowedDepths = new Set(depths.map(String));
  if (Object.keys(overrides).some((depth) => !allowedDepths.has(depth))) return false;
  return depths.every((depth) =>
    modelConfigurationIsValid(resolvedModelConfiguration(value, depth), providers, catalog)
  );
}

function modeButtonStyle(active) {
  return active
    ? {
        borderColor: 'var(--accent)',
        background: 'var(--accent-subtle)',
        color: 'var(--accent-strong)',
      }
    : undefined;
}

export default function WorkflowModelConfiguration({
  value,
  onChange,
  depths,
  depthChips = [],
  providers,
  catalog,
  catalogError,
  disabled = false,
}) {
  const overrides = modelOverridesDraft(value?.model_overrides ?? value?.modelOverrides);
  const customized = Object.keys(overrides).length > 0;
  const canCustomize = depths.length > 0;
  const depthLabels = new Map(depthChips.map((chip) => [chip.depth, chip]));
  const postProcessingModelOverride = postProcessingOverrideEnabled(value);
  const postProcessingConfiguration = postProcessingModelConfiguration(value);
  const postProcessingEfforts = thinkingEffortsForModel(
    catalog,
    postProcessingConfiguration.model_provider,
    postProcessingConfiguration.model,
    THINKING_EFFORTS,
    postProcessingConfiguration.harness
  );

  const useSingleModel = () => onChange({ ...value, model_overrides: {} });
  const customizeByDepth = () =>
    onChange({
      ...value,
      model_overrides: enableModelOverrides(depths, value, overrides),
    });

  return (
    <>
      <div
        role="group"
        aria-label="Workflow model strategy"
        style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-3)', marginBottom: 'var(--space-5)' }}
      >
        <button
          type="button"
          className="btn btn--sm"
          aria-pressed={!customized}
          disabled={disabled}
          onClick={useSingleModel}
          style={modeButtonStyle(!customized)}
        >
          One model for all depths
        </button>
        <button
          type="button"
          className="btn btn--sm"
          aria-pressed={customized}
          disabled={disabled || !canCustomize}
          onClick={customizeByDepth}
          style={modeButtonStyle(customized)}
        >
          Customize by depth
        </button>
      </div>

      {customized && (
        <div className="field-label" style={{ marginBottom: 'var(--space-4)' }}>
          DEFAULT WORKFLOW MODEL
        </div>
      )}
      <ModelConfiguration
        value={value}
        onChange={(configuration) => onChange({ ...value, ...configuration })}
        providers={providers}
        catalog={catalog}
        catalogError={catalogError}
        disabled={disabled}
      />

      <div
        style={{
          marginTop: 'var(--space-7)',
          paddingTop: 'var(--space-6)',
          borderTop: '1px solid var(--border)',
        }}
      >
        <div className="field-label" style={{ marginBottom: 'var(--space-4)' }}>
          POST-PROCESSING MODEL
        </div>
        <div
          role="group"
          aria-label="Post-processing model strategy"
          style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-3)', marginBottom: 'var(--space-5)' }}
        >
          <button
            type="button"
            className="btn btn--sm"
            aria-pressed={!postProcessingModelOverride}
            disabled={disabled}
            onClick={() =>
              onChange({
                ...value,
                post_processing_model_override: false,
                post_processing_model: value.model,
                post_processing_model_provider: value.model_provider,
                post_processing_harness: value.harness,
              })
            }
            style={modeButtonStyle(!postProcessingModelOverride)}
          >
            Use scan model
          </button>
          <button
            type="button"
            className="btn btn--sm"
            aria-pressed={postProcessingModelOverride}
            disabled={disabled}
            onClick={() =>
              onChange({
                ...value,
                post_processing_model_override: true,
                post_processing_model: postProcessingConfiguration.model,
                post_processing_model_provider: postProcessingConfiguration.model_provider,
                post_processing_harness: postProcessingConfiguration.harness,
              })
            }
            style={modeButtonStyle(postProcessingModelOverride)}
          >
            Use different model
          </button>
        </div>

        {postProcessingModelOverride ? (
          <ModelConfiguration
            value={postProcessingConfiguration}
            onChange={(configuration) =>
              onChange({
                ...value,
                post_processing_model_override: true,
                post_processing_model: configuration.model,
                post_processing_model_provider: configuration.model_provider,
                post_processing_harness: configuration.harness,
                post_processing_thinking_effort: configuration.thinking_effort,
              })
            }
            providers={providers}
            catalog={catalog}
            catalogError={catalogError}
            disabled={disabled}
            showAvailabilityHelp={false}
          />
        ) : (
          <label className="field" style={{ maxWidth: 280 }}>
            <span className="field-label">Thinking effort</span>
            <select
              className="select"
              value={postProcessingConfiguration.thinking_effort}
              disabled={disabled || postProcessingEfforts.length === 0}
              onChange={(event) => onChange({ ...value, post_processing_thinking_effort: event.target.value })}
            >
              {postProcessingEfforts.map((effort) => (
                <option key={effort} value={effort}>
                  {effort}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>

      {customized && (
        <div style={{ marginTop: 'var(--space-7)', borderTop: '1px solid var(--border)' }}>
          {depths.map((depth) => {
            const chip = depthLabels.get(depth);
            const configuration = resolvedModelConfiguration(value, depth);
            return (
              <div
                key={depth}
                style={{
                  padding: 'var(--space-6) 0',
                  borderBottom: '1px solid var(--border-2)',
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 'var(--space-4)',
                    marginBottom: 'var(--space-4)',
                    color: 'var(--text-2)',
                    fontSize: 'var(--text-xs)',
                  }}
                >
                  <span>DEPTH {depth}</span>
                  {chip?.count ? (
                    <span>
                      {chip.count} {chip.count === 1 ? 'step' : 'steps'}
                    </span>
                  ) : null}
                </div>
                <ModelConfiguration
                  value={configuration}
                  onChange={(nextConfiguration) =>
                    onChange({
                      ...value,
                      model_overrides: {
                        ...overrides,
                        [`${depth}`]: modelSelectionDraft(nextConfiguration),
                      },
                    })
                  }
                  providers={providers}
                  catalog={catalog}
                  catalogError={catalogError}
                  disabled={disabled}
                  showAvailabilityHelp={false}
                />
              </div>
            );
          })}
        </div>
      )}

      {!canCustomize && (
        <div style={{ marginTop: 'var(--space-4)', color: 'var(--text-3)', fontSize: 'var(--text-xs)' }}>
          Select a workflow to configure models by depth.
        </div>
      )}
    </>
  );
}

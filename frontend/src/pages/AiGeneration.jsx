import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../api/client.js';
import ModelConfiguration, {
  modelConfigurationForCatalog,
  modelConfigurationIsValid,
} from '../components/ModelConfiguration.jsx';
import { Button, SectionLabel, Spinner } from '../components/ui.jsx';
import { Page, PageHeader } from '../components/app.jsx';
import ResourceNotice from '../components/ResourceNotice.jsx';
import { usePageChrome } from '../context/ui.jsx';
import { configuredModelCatalog, configuredModelProviders, modelCatalogIsReady } from '../lib/modelProviders.js';
import {
  GENERATION_POLL_FAILURE_LIMIT,
  generationIsRunning,
  generationPollErrorIsTerminal,
  generationPollShouldRetry,
} from '../lib/generationPolling.js';
import { apiErrorMessages, generationFailureViewModel } from '../lib/generationFailure.js';

const MODEL_CATALOG_RETRY_LIMIT = 25;
const MODEL_CATALOG_RETRY_DELAY_MS = 1_000;
const GENERATION_POLL_MS = 1_500;

const COPY = {
  workflow: {
    label: 'workflow',
    plural: 'Workflows',
    listPath: '/workflows',
    editorPath: '/workflows/new',
    title: 'Generate a workflow with AI',
    subtitle: 'Describe the security research process you want. You will review the generated draft before saving it.',
    guidance:
      'Include the objective, the stages and their order, what each stage should produce, any sibling or fan-out behavior, constraints and exclusions, and values scan users should supply through extra.<key>.',
    placeholder:
      'I want a two-stage workflow. First, discover every externally reachable entrypoint available to an unauthenticated actor. Then investigate each entrypoint for specific impacts. Create one sibling research step per impact, supplied at scan time through extra values. Each research step should trace the complete flow and report only concrete, exploitable vulnerabilities…',
  },
  post_script: {
    label: 'post-script',
    plural: 'Post-scripts',
    listPath: '/post-scripts',
    editorPath: '/post-scripts/new',
    title: 'Generate a post-script with AI',
    subtitle:
      'Describe how findings should be enriched or graded. You will review the generated draft before saving it.',
    guidance:
      'Include the evaluation criteria, desired output fields and types, edge cases, and whether results should add up to three _chip_ values, a detailed _reserved_report, or a _reserved_poc section.',
    placeholder:
      'For every finding, assess exploitability and likely impact. Add compact chips for exploitability and confidence, explain the decision with evidence from the finding, and produce a detailed markdown report only when the issue is exploitable…',
  },
};

export default function AiGeneration({ kind }) {
  const copy = COPY[kind];
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const generationId = searchParams.get('job');

  const [request, setRequest] = useState('');
  const [modelConfiguration, setModelConfiguration] = useState({
    model: '',
    model_provider: '',
    harness: '',
    thinking_effort: 'medium',
  });
  const [referenceData, setReferenceData] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [catalogError, setCatalogError] = useState(null);
  const [catalogRetryCount, setCatalogRetryCount] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [submitErrors, setSubmitErrors] = useState([]);
  const [job, setJob] = useState(null);
  const [pollError, setPollError] = useState(null);
  const [pollPaused, setPollPaused] = useState(false);
  const [pollRevision, setPollRevision] = useState(0);

  usePageChrome(
    [
      { label: copy.plural, to: copy.listPath },
      { label: `Generate ${copy.label}`, active: true },
    ],
    null,
    [kind]
  );

  useEffect(() => {
    let active = true;
    let hasLoaded = false;
    const refresh = () =>
      Promise.all([
        api.modelProviders(),
        api.modelCatalog().then(
          (catalog) => ({ catalog, error: null }),
          (error) => ({ catalog: null, error })
        ),
      ])
        .then(([providerPayload, catalogResult]) => {
          if (!active) return;
          const providers = configuredModelProviders(providerPayload);
          const catalog = configuredModelCatalog(catalogResult.catalog);
          hasLoaded = true;
          setLoadError(null);
          setCatalogError(catalogResult.error);
          setReferenceData({ providers, catalog });
          setModelConfiguration((current) => modelConfigurationForCatalog(current, providers, catalog));
        })
        .catch((error) => {
          if (active && !hasLoaded) setLoadError(error);
        });
    refresh();
    const timer = setInterval(refresh, 5000);
    window.addEventListener('focus', refresh);
    return () => {
      active = false;
      clearInterval(timer);
      window.removeEventListener('focus', refresh);
    };
  }, []);

  useEffect(() => {
    if (!referenceData || catalogRetryCount >= MODEL_CATALOG_RETRY_LIMIT) return undefined;
    const needsRetry = referenceData.providers.some(
      (provider) => !modelCatalogIsReady(referenceData.catalog, provider)
    );
    if (!needsRetry) return undefined;

    const timer = setTimeout(() => {
      api
        .modelCatalog()
        .then((payload) => {
          const catalog = configuredModelCatalog(payload);
          setReferenceData((current) => (current ? { ...current, catalog } : current));
          setModelConfiguration((current) => modelConfigurationForCatalog(current, referenceData.providers, catalog));
          setCatalogError(null);
        })
        .catch(setCatalogError)
        .finally(() => setCatalogRetryCount((count) => count + 1));
    }, MODEL_CATALOG_RETRY_DELAY_MS);
    return () => clearTimeout(timer);
  }, [catalogRetryCount, referenceData]);

  useEffect(() => {
    if (!generationId) {
      setJob(null);
      setPollError(null);
      setPollPaused(false);
      return undefined;
    }

    let active = true;
    let timer = null;
    let consecutiveFailures = 0;
    const poll = async () => {
      try {
        const next = await api.generation(generationId);
        if (!active) return;
        consecutiveFailures = 0;
        setJob(next);
        setPollError(null);
        setPollPaused(false);
        if (typeof next.request === 'string') setRequest((current) => current || next.request);
        setModelConfiguration((current) => ({
          ...current,
          ...(typeof next.model === 'string' ? { model: next.model } : {}),
          ...(typeof next.modelProvider === 'string' ? { model_provider: next.modelProvider } : {}),
          ...(typeof next.harness === 'string' ? { harness: next.harness } : {}),
          ...(typeof next.thinkingEffort === 'string' ? { thinking_effort: next.thinkingEffort } : {}),
        }));
        if (next.status === 'completed') {
          const editorPath = COPY[next.kind]?.editorPath || copy.editorPath;
          navigate(`${editorPath}?generation=${next.id}`, { replace: true });
          return;
        }
        if (next.status !== 'failed') timer = setTimeout(poll, GENERATION_POLL_MS);
      } catch (error) {
        if (!active) return;
        consecutiveFailures += 1;
        setPollError(error);
        if (generationPollShouldRetry(error, consecutiveFailures)) timer = setTimeout(poll, GENERATION_POLL_MS);
        else if (!generationPollErrorIsTerminal(error)) setPollPaused(true);
      }
    };
    poll();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [copy.editorPath, generationId, navigate, pollRevision]);

  const fatalPollError = generationPollErrorIsTerminal(pollError);
  const generationRunning = generationIsRunning(generationId, job, pollError);
  const pollingStopped = fatalPollError || pollPaused;
  const configurationValid =
    !!referenceData && modelConfigurationIsValid(modelConfiguration, referenceData.providers, referenceData.catalog);
  const canGenerate = request.trim() && configurationValid && !submitting && !generationRunning;

  const startGeneration = async () => {
    if (!canGenerate) return;
    setSubmitting(true);
    setSubmitErrors([]);
    setPollError(null);
    setJob(null);
    try {
      const created = await api.createGeneration({
        kind,
        request: request.trim(),
        ...modelConfiguration,
      });
      setSearchParams({ job: created.id }, { replace: true });
    } catch (error) {
      setSubmitErrors(apiErrorMessages(error));
    } finally {
      setSubmitting(false);
    }
  };

  const resumePolling = () => {
    setPollPaused(false);
    setPollError(null);
    setPollRevision((revision) => revision + 1);
  };

  const errors = pollingStopped
    ? [
        pollPaused
          ? `${pollError?.message || 'The backend could not be reached.'} Status checks paused after ${GENERATION_POLL_FAILURE_LIMIT} attempts.`
          : pollError.message,
      ]
    : submitErrors;
  const blockedLabel = !request.trim()
    ? `Describe the ${copy.label}`
    : !referenceData?.providers.length
      ? 'Run ./kritt setup'
      : !configurationValid
        ? 'Choose a valid model configuration'
        : `Generate ${copy.label}`;
  const primaryEnabled = pollPaused || canGenerate;

  return (
    <Page>
      <PageHeader title={copy.title} meta={copy.subtitle} />

      <div style={{ maxWidth: 920 }}>
        <div className="field">
          <label className="field-label" htmlFor={`generation-${kind}-request`}>
            <span>Describe the {copy.label}</span>
            <span className="field-unit">{request.length.toLocaleString()} / 20,000</span>
          </label>
          <textarea
            id={`generation-${kind}-request`}
            className="textarea"
            value={request}
            onChange={(event) => setRequest(event.target.value)}
            disabled={generationRunning || submitting}
            maxLength={20_000}
            placeholder={copy.placeholder}
            style={{
              minHeight: 240,
              padding: 'var(--space-5)',
              fontSize: 'var(--text-base)',
              lineHeight: 'var(--leading-prose)',
              resize: 'vertical',
            }}
          />
          <div className="field-note" style={{ maxWidth: '72ch' }}>
            {copy.guidance}
          </div>
        </div>

        <section style={{ marginTop: 'var(--space-9)' }}>
          <div className="section-head" style={{ marginBottom: 'var(--space-5)' }}>
            <div>
              <h2>Model and harness</h2>
            </div>
          </div>
          {loadError ? (
            <GenerationError title="Could not load model options" errors={[loadError.message]} />
          ) : referenceData ? (
            <ModelConfiguration
              value={modelConfiguration}
              onChange={setModelConfiguration}
              providers={referenceData.providers}
              catalog={referenceData.catalog}
              catalogError={catalogError}
              disabled={generationRunning || submitting}
            />
          ) : (
            <Spinner label="Loading configured models…" />
          )}
        </section>

        {(generationRunning || job?.status === 'failed' || errors.length > 0) && (
          <section style={{ marginTop: 'var(--space-8)' }}>
            {generationRunning && !pollingStopped ? (
              <GenerationProgress status={job?.status || 'pending'} kind={copy.label} notice={job?.resourceNotice} />
            ) : job?.status === 'failed' ? (
              <GenerationFailure job={job} kind={copy.label} />
            ) : (
              <GenerationError
                title={pollPaused ? 'Status check paused' : 'Could not start generation'}
                errors={errors.length ? errors : [`The ${copy.label} could not be generated.`]}
              />
            )}
          </section>
        )}

        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 'var(--space-4)',
            marginTop: 'var(--space-9)',
            paddingTop: 'var(--space-5)',
            borderTop: '1px solid var(--border)',
          }}
        >
          <Link className="btn btn--quiet" to={copy.listPath}>
            Back to {copy.plural.toLowerCase()}
          </Link>
          <Button onClick={pollPaused ? resumePolling : startGeneration} disabled={!primaryEnabled}>
            {pollPaused
              ? 'Check status again'
              : submitting
                ? 'Submitting…'
                : generationRunning
                  ? job?.status === 'running'
                    ? 'Generating…'
                    : 'Waiting for engine…'
                  : job?.status === 'failed'
                    ? 'Try again'
                    : blockedLabel}
          </Button>
        </div>
      </div>
    </Page>
  );
}

function GenerationProgress({ status, kind, notice }) {
  return (
    <div role="status" aria-live="polite" className="state-block" style={{ borderStyle: 'solid' }}>
      <Spinner label={status === 'running' ? `Generating and validating your ${kind}…` : 'Waiting for the engine…'} />
      <div className="state-note">Invalid output is rejected before it reaches the editor.</div>
      {status === 'pending' && <ResourceNotice notice={notice} />}
    </div>
  );
}

function GenerationFailure({ job, kind }) {
  const failure = generationFailureViewModel(job, kind);
  const runDetails = [
    { label: 'Reference', value: failure.reference },
    ...(failure.diagnosticCode ? [{ label: 'Diagnostic code', value: failure.diagnosticCode }] : []),
    ...(failure.submittedAt ? [{ label: 'Submitted', value: failure.submittedAt }] : []),
    ...(failure.startedAt ? [{ label: 'Started', value: failure.startedAt }] : []),
    ...(failure.completedAt ? [{ label: 'Finished', value: failure.completedAt }] : []),
    ...(failure.duration ? [{ label: 'Run time', value: failure.duration }] : []),
  ];
  const titleId = `generation-failure-title-${failure.generationId || 'current'}`;

  return (
    <section
      className="panel"
      role="alert"
      aria-live="assertive"
      aria-labelledby={titleId}
      style={{ borderColor: 'var(--fail)' }}
    >
      <div className="panel-head">
        <div style={{ minWidth: 0 }}>
          <div className="field-note" style={{ color: 'var(--fail)' }}>
            Generation failed
          </div>
          <h2 id={titleId} className="panel-title" style={{ fontSize: 'var(--text-md)' }}>
            {failure.title}
          </h2>
        </div>
        <span
          className="mono"
          style={{ color: 'var(--text-3)', fontSize: 'var(--text-xs)', overflowWrap: 'anywhere', textAlign: 'right' }}
        >
          {failure.reference}
        </span>
      </div>

      <div className="panel-body" style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-6)' }}>
        <div>
          <SectionLabel style={{ marginBottom: 'var(--space-3)' }}>What happened</SectionLabel>
          <div
            style={{
              padding: 'var(--space-5)',
              borderRadius: 'var(--radius-sm)',
              background: 'var(--fail-bg)',
              color: 'var(--text)',
              lineHeight: 'var(--leading-base)',
              overflowWrap: 'anywhere',
            }}
          >
            {job.resourceFailure?.message || failure.message}
            {job.resourceFailure?.fixLinks?.map((link) => (
              <div key={link.url} style={{ marginTop: 'var(--space-3)' }}>
                <Link to={link.url}>{link.label}</Link>
              </div>
            ))}
          </div>
        </div>

        {failure.issues.length > 0 && (
          <div>
            <SectionLabel style={{ marginBottom: 'var(--space-2)' }}>
              <span>Draft validation issues</span>
              <span className="field-unit">{failure.issues.length}</span>
            </SectionLabel>
            <ul style={{ listStyle: 'none', margin: 0, padding: 0, borderTop: '1px solid var(--border)' }}>
              {failure.issues.map((issue, index) => (
                <li className="generation-validation-issue" key={`${issue.field}-${issue.message}-${index}`}>
                  <span
                    className="mono"
                    style={{ color: 'var(--fail)', fontSize: 'var(--text-2xs)', overflowWrap: 'anywhere' }}
                  >
                    {issue.field}
                  </span>
                  <span style={{ color: 'var(--text-2)', lineHeight: 'var(--leading-base)', overflowWrap: 'anywhere' }}>
                    {issue.message}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}

        <div>
          <SectionLabel style={{ marginBottom: 'var(--space-3)' }}>Run configuration</SectionLabel>
          <div className="generation-failure-context" style={{ paddingBottom: 0 }}>
            {failure.configuration.map((item) => (
              <div key={item.label} style={{ minWidth: 0 }}>
                <div className="field-note" style={{ marginBottom: 'var(--space-1)' }}>
                  {item.label}
                </div>
                <div
                  className="mono"
                  style={{ color: 'var(--text)', fontSize: 'var(--text-2xs)', overflowWrap: 'anywhere' }}
                >
                  {item.value}
                </div>
              </div>
            ))}
          </div>
        </div>

        <details style={{ color: 'var(--text-2)', fontSize: 'var(--text-xs)' }}>
          <summary style={{ cursor: 'pointer', fontWeight: 500 }}>Technical details</summary>
          <dl className="generation-failure-run-details">
            {runDetails.map((item) => (
              <div key={item.label} style={{ minWidth: 0 }}>
                <dt className="field-note">{item.label}</dt>
                <dd className="mono" style={{ margin: 'var(--space-1) 0 0', overflowWrap: 'anywhere' }}>
                  {item.value}
                </dd>
              </div>
            ))}
          </dl>
        </details>

        <p className="field-note">
          Your description is preserved above. Adjust it or the model configuration, then try again.
        </p>
      </div>
    </section>
  );
}

function GenerationError({ errors, title = 'Generation failed' }) {
  return (
    <div role="alert" aria-live="assertive" className="state-block state-block--error">
      <div className="state-title">{title}</div>
      <ul className="state-note" style={{ margin: 0, paddingLeft: 'var(--space-6)' }}>
        {errors.map((error, index) => (
          <li key={`${error}-${index}`} style={{ overflowWrap: 'anywhere' }}>
            {error}
          </li>
        ))}
      </ul>
    </div>
  );
}

import { useEffect, useRef, useState } from 'react';
import { Link, useParams, useNavigate } from 'react-router-dom';
import { api, ApiError } from '../api/client.js';
import { useFetch } from '../lib/useFetch.js';
import { usePageChrome } from '../context/ui.jsx';
import { Spinner, ErrorState, StatusBadge, Button } from '../components/ui.jsx';
import { Page, PageHeader, FigureStrip, Figure } from '../components/app.jsx';
import LinkifiedText from '../components/LinkifiedText.jsx';
import ResourceNotice from '../components/ResourceNotice.jsx';
import {
  sevColor,
  findingSeverity,
  providerCapacityAutoscalePresentation,
  rateLimitPresentation,
  rateLimitRetryText,
  storageWarningPresentation,
} from '../lib/format.js';
import { isScanDeletable, postOutputSummary } from '../lib/scanPresentation.js';
import { configuredModelCatalog, configuredModelProviders } from '../lib/modelProviders.js';
import { createLatestFieldMutationQueue } from '../lib/latestMutation.js';
import { duplicateScanPath } from '../lib/scanDuplication.js';
import { useUnsavedChangesPrompt } from '../lib/useUnsavedChangesPrompt.js';
import WorkflowModelConfiguration, {
  workflowModelConfigurationForCatalog,
  workflowModelConfigurationIsValid,
} from '../components/WorkflowModelConfiguration.jsx';
import ModelConfiguration, {
  modelConfigurationForCatalog,
  modelConfigurationIsValid,
} from '../components/ModelConfiguration.jsx';
import { modelOverridesDraft, modelOverridesEqual, reconcileModelOverrides } from '../lib/modelOverrides.js';
import { usePagination } from '../lib/usePagination.js';
import Pagination from '../components/Pagination.jsx';
import { saveBrowserDownload } from '../lib/download.js';
import { extractExtraKeys } from '../lib/keys.js';
import SelfImprovementPanel from '../components/self-improvement/SelfImprovementPanel.jsx';
import EvidenceArchives from '../components/EvidenceArchives.jsx';

const SUPPLEMENTAL_POST_SCRIPT_SCAN_STATUSES = new Set(['paused', 'completed', 'stopped', 'failed']);

// Sibling panels must not share a key. A bare scan id previously collided with
// SelfImprovementPanel and made React duplicate the archive panel on every poll.
export function scanPanelKeys(scanId) {
  return {
    evidenceArchives: `evidence-archives-${scanId}`,
    selfImprovement: `self-improvement-${scanId}`,
  };
}

export function scanActions(status) {
  const active = ['prewarming_cache', 'running', 'post_processing'].includes(status);
  return {
    canPause: active,
    canResume: ['paused', 'failed', 'stopped'].includes(status),
    canStop: ['queued', 'pending', 'prewarming_cache', 'running', 'rate_limited', 'paused', 'post_processing'].includes(
      status
    ),
    canDelete: isScanDeletable(status),
    stopLabel: ['queued', 'pending'].includes(status) ? 'Cancel' : status === 'rate_limited' ? 'Stop retrying' : 'Stop',
  };
}

export function scanFindingExportAvailability(scan) {
  if (!['completed', 'stopped', 'failed'].includes(scan?.status)) {
    return {
      ready: false,
      message: 'Available after the scan completes, stops, or fails.',
    };
  }
  if (!Number(scan?.findings)) return { ready: false, message: 'This scan has no findings to export.' };
  if (scan.status !== 'completed') {
    return {
      ready: true,
      message: `Download a partial export from this ${scan.status} scan. Some findings or post-processing artifacts may be missing.`,
    };
  }
  return {
    ready: true,
    message: 'Download a share-safe index and untrusted finding, report, PoC, and post-processing content.',
  };
}

export function supplementalPostScriptAvailability(scan, findings = []) {
  if (!SUPPLEMENTAL_POST_SCRIPT_SCAN_STATUSES.has(scan?.status)) {
    return { ready: false, message: 'Pause or stop the scan before adding post-processing.' };
  }
  if (!Array.isArray(findings) || findings.length === 0) {
    return { ready: false, message: 'At least one finding is required.' };
  }
  return { ready: true, message: 'Run a post-script on selected findings without resuming the scan.' };
}

export function supplementalFindingRunSummary(finding, runs = []) {
  const runIds = new Set(
    (finding?.enrichments || [])
      .map((enrichment) => enrichment?.supplementalRunId)
      .filter(Boolean)
      .map(String)
  );
  let active = 0;
  let failed = 0;
  for (const run of runs || []) {
    const target = (run?.targets || []).find((item) => String(item.vulnerabilityId) === String(finding?.id));
    if (!target) continue;
    runIds.add(String(run.id));
    if (['pending', 'running'].includes(target.status)) active += 1;
    if (target.status === 'failed') failed += 1;
  }
  return { count: runIds.size, active, failed };
}

export function supplementalRunModelConfiguration(scan = {}, run = null) {
  return {
    model: run?.model || scan.postProcessingModel || scan.model || '',
    model_provider: run?.modelProvider || scan.postProcessingModelProvider || scan.modelProvider || 'openrouter',
    harness: run?.harness || scan.postProcessingHarness || scan.harness || '',
    thinking_effort: run?.thinkingEffort || scan.postProcessingThinkingEffort || scan.thinkingEffort || 'medium',
  };
}

export async function loadModelReferences(fetchProviders, fetchCatalog) {
  const [providerPayload, catalogResult] = await Promise.all([
    Promise.resolve().then(fetchProviders),
    Promise.resolve()
      .then(fetchCatalog)
      .then(
        (catalog) => ({ catalog, error: null }),
        (error) => ({ catalog: null, error })
      ),
  ]);
  return {
    providers: configuredModelProviders(providerPayload),
    catalog: configuredModelCatalog(catalogResult.catalog),
    catalogError: catalogResult.error,
  };
}

export default function ScanDetail() {
  const { id } = useParams();
  const panelKeys = scanPanelKeys(id);
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [actionError, setActionError] = useState(null);
  const [extrasOpen, setExtrasOpen] = useState(false);
  const [reviewError, setReviewError] = useState(null);
  const [supplementalMode, setSupplementalMode] = useState(false);
  const [selectedFindingIds, setSelectedFindingIds] = useState(() => new Set());
  const [supplementalPostScriptId, setSupplementalPostScriptId] = useState('');
  const [supplementalExtra, setSupplementalExtra] = useState({});
  const [supplementalModel, setSupplementalModel] = useState(null);
  const [supplementalSubmitting, setSupplementalSubmitting] = useState(false);
  const [supplementalError, setSupplementalError] = useState(null);
  const [supplementalRetry, setSupplementalRetry] = useState(null);
  const [supplementalRetrySubmitting, setSupplementalRetrySubmitting] = useState(false);
  const [supplementalRetryError, setSupplementalRetryError] = useState(null);
  const reviewMutations = useRef(createLatestFieldMutationQueue());
  const { data: scan, loading, error, reload } = useFetch(() => api.scan(id), [id], { pollMs: 1000 });
  const {
    data: vulns,
    loading: vulnsLoading,
    error: vulnsError,
    reload: reloadVulns,
    setData: setVulns,
  } = useFetch(
    () => api.scanVulnerabilities(id).then((records) => reviewMutations.current.overlayRecords(records)),
    [id],
    { pollMs: 1000 }
  );
  const {
    data: modelReferences,
    loading: modelReferencesLoading,
    error: modelReferencesError,
    reload: reloadModelReferences,
  } = useFetch(
    () =>
      loadModelReferences(
        () => api.modelProviders(),
        () => api.modelCatalog()
      ),
    [],
    { pollMs: 5000 }
  );
  const {
    data: availablePostScripts,
    loading: availablePostScriptsLoading,
    error: availablePostScriptsError,
    reload: reloadAvailablePostScripts,
  } = useFetch(() => api.postScripts(), [], {});
  const {
    data: supplementalRuns,
    error: supplementalRunsError,
    reload: reloadSupplementalRuns,
    setData: setSupplementalRuns,
  } = useFetch(() => api.supplementalPostScriptRuns(id), [id], { pollMs: 1000 });

  useEffect(() => {
    reviewMutations.current.dispose();
    const queue = createLatestFieldMutationQueue();
    reviewMutations.current = queue;
    setReviewError(null);
    return () => queue.dispose();
  }, [id]);

  useEffect(() => {
    setSupplementalMode(false);
    setSelectedFindingIds(new Set());
    setSupplementalPostScriptId('');
    setSupplementalExtra({});
    setSupplementalModel(null);
    setSupplementalError(null);
    setSupplementalRetry(null);
    setSupplementalRetryError(null);
  }, [id]);

  const findingPages = usePagination(vulns || [], { pageSize: 20, resetKey: id });

  const setStatus = async (status) => {
    setBusy(true);
    setActionError(null);
    try {
      await api.updateScanStatus(id, status);
      reload();
    } catch (statusError) {
      setActionError(statusError);
    } finally {
      setBusy(false);
    }
  };

  const saveRunSettings = async (settings) => {
    await api.updateScan(id, settings);
    reload();
  };

  const deleteScan = async () => {
    const confirmed = window.confirm(
      'Permanently delete this scan and all findings, attempts, logs, and review data? This cannot be undone.'
    );
    if (!confirmed) return;
    setBusy(true);
    setActionError(null);
    try {
      await api.deleteScan(id);
      navigate('/scans', { replace: true });
    } catch (deleteError) {
      setActionError(deleteError);
      setBusy(false);
    }
  };

  const exportFindings = async () => {
    if (exporting) return;
    setExporting(true);
    setActionError(null);
    try {
      saveBrowserDownload(await api.exportScanFindings(id));
    } catch (exportError) {
      setActionError(exportError);
    } finally {
      setExporting(false);
    }
  };

  // Optimistically update review fields. Per-record queues ensure rapid clicks
  // reach the server in order, and pending overlays survive background polls.
  const saveVuln = (vuln, patch) => {
    const fields = Object.keys(patch);
    setReviewError(null);
    setVulns((prev) => (prev || []).map((item) => (item.id === vuln.id ? { ...item, ...patch } : item)));
    for (const field of fields) {
      const value = patch[field];
      reviewMutations.current.enqueue({
        scope: vuln.id,
        field,
        value,
        mutate: () => api.updateVulnerability(vuln.id, { [field]: value }),
        onSuccess: (saved) => {
          if (!saved) return;
          setVulns((prev) =>
            (prev || []).map((item) => (item.id === vuln.id ? { ...item, [field]: saved[field] } : item))
          );
        },
        onError: (saveError) => {
          setReviewError(saveError);
          reloadVulns();
        },
      });
    }
  };
  const cycleInteresting = (v, e) => {
    e.stopPropagation();
    const cur = v.interesting ?? null;
    const next = cur === null ? 1 : cur === 1 ? 0 : null;
    saveVuln(v, { interesting: next });
  };

  usePageChrome(
    [
      { label: 'Scans', to: '/scans' },
      { label: scan?.repoDisplay || scan?.repoFull || '…', active: true },
    ],
    null,
    [scan?.repoDisplay]
  );

  if (loading)
    return (
      <Page>
        <Spinner />
      </Page>
    );
  if (error)
    return (
      <Page>
        <ErrorState error={error} onRetry={reload} />
      </Page>
    );
  if (!scan) return null;

  const list = vulns || [];
  const extraEntries = scan.extra && typeof scan.extra === 'object' ? Object.entries(scan.extra) : [];
  const actions = scanActions(scan.status);
  const exportAvailability = scanFindingExportAvailability(scan);
  const agentSkills =
    Array.isArray(scan.agentSkills) && scan.agentSkills.length
      ? scan.agentSkills
      : (scan.agentSkillNames || []).map((name) => ({ name }));
  const postScripts =
    Array.isArray(scan.postScripts) && scan.postScripts.length
      ? scan.postScripts
      : scan.postScriptName
        ? [{ id: scan.postScriptId, name: scan.postScriptName, primary: true }]
        : [];
  const rateLimit = rateLimitPresentation(scan.reasoning);
  const providerAutoscale = providerCapacityAutoscalePresentation(scan.reasoning);
  const storageWarning = storageWarningPresentation(scan.reasoning, scan.status);
  const supplementalAvailability = supplementalPostScriptAvailability(scan, list);
  const selectedPostScript = (availablePostScripts || []).find(
    (postScript) => String(postScript.id) === supplementalPostScriptId
  );
  const supplementalExtraKeys = extractExtraKeys(selectedPostScript?.content || '');
  const selectedCount = selectedFindingIds.size;
  const allFindingsSelected = list.length > 0 && selectedCount === list.length;
  const activeSupplementalRuns = (supplementalRuns || []).filter((run) => ['queued', 'running'].includes(run.status));
  const modelOverrideCount = Object.keys(scan.modelOverrides || {}).length;

  const beginSupplementalRun = () => {
    const defaults = supplementalRunModelConfiguration(scan);
    setSupplementalMode(true);
    setSelectedFindingIds(new Set());
    setSupplementalPostScriptId('');
    setSupplementalExtra({});
    setSupplementalModel(
      modelReferences
        ? modelConfigurationForCatalog(defaults, modelReferences.providers, modelReferences.catalog)
        : defaults
    );
    setSupplementalError(null);
    setSupplementalRetry(null);
    setSupplementalRetryError(null);
  };
  const cancelSupplementalRun = () => {
    setSupplementalMode(false);
    setSelectedFindingIds(new Set());
    setSupplementalPostScriptId('');
    setSupplementalExtra({});
    setSupplementalModel(null);
    setSupplementalError(null);
  };
  const toggleFindingSelection = (vulnerabilityId) => {
    setSelectedFindingIds((current) => {
      const next = new Set(current);
      if (next.has(vulnerabilityId)) next.delete(vulnerabilityId);
      else next.add(vulnerabilityId);
      return next;
    });
  };
  const toggleAllFindingSelection = () => {
    setSelectedFindingIds(allFindingsSelected ? new Set() : new Set(list.map((finding) => finding.id)));
  };
  const chooseSupplementalPostScript = (postScriptId) => {
    setSupplementalPostScriptId(postScriptId);
    const postScript = (availablePostScripts || []).find((item) => String(item.id) === postScriptId);
    const nextExtra = {};
    for (const key of extractExtraKeys(postScript?.content || '')) {
      nextExtra[key] = scan.extra?.[key] === undefined ? '' : formatExtraValue(scan.extra[key]);
    }
    setSupplementalExtra(nextExtra);
    setSupplementalError(null);
  };
  const submitSupplementalRun = async () => {
    if (!selectedCount) {
      setSupplementalError(new Error('Select at least one finding.'));
      return;
    }
    if (!selectedPostScript) {
      setSupplementalError(new Error('Choose a post-script.'));
      return;
    }
    const missingKey = supplementalExtraKeys.find((key) => !String(supplementalExtra[key] ?? '').trim());
    if (missingKey) {
      setSupplementalError(new Error(`extra.${missingKey} is required.`));
      return;
    }
    if (
      !supplementalModel ||
      !modelReferences ||
      !modelConfigurationIsValid(supplementalModel, modelReferences.providers, modelReferences.catalog)
    ) {
      setSupplementalError(new Error('Choose an available model, compatible harness, and supported thinking effort.'));
      return;
    }
    setSupplementalSubmitting(true);
    setSupplementalError(null);
    try {
      await api.createSupplementalPostScriptRun(id, {
        postScriptId: selectedPostScript.id,
        vulnerabilityIds: [...selectedFindingIds],
        extra: Object.fromEntries(supplementalExtraKeys.map((key) => [key, supplementalExtra[key]])),
        model: supplementalModel.model,
        model_provider: supplementalModel.model_provider,
        harness: supplementalModel.harness,
        thinking_effort: supplementalModel.thinking_effort,
      });
      cancelSupplementalRun();
      reloadSupplementalRuns();
      reloadVulns();
    } catch (submitError) {
      setSupplementalError(submitError);
    } finally {
      setSupplementalSubmitting(false);
    }
  };
  const beginSupplementalRetry = (run) => {
    const defaults = supplementalRunModelConfiguration(scan, run);
    cancelSupplementalRun();
    setSupplementalRetry({
      runId: run.id,
      model: modelReferences
        ? modelConfigurationForCatalog(defaults, modelReferences.providers, modelReferences.catalog)
        : defaults,
    });
    setSupplementalRetryError(null);
  };
  const submitSupplementalRetry = async () => {
    if (!supplementalRetry) return;
    if (
      !modelReferences ||
      !modelConfigurationIsValid(supplementalRetry.model, modelReferences.providers, modelReferences.catalog)
    ) {
      setSupplementalRetryError(
        new Error('Choose an available model, compatible harness, and supported thinking effort.')
      );
      return;
    }
    setSupplementalRetrySubmitting(true);
    setSupplementalRetryError(null);
    try {
      const createdRun = await api.retrySupplementalPostScriptRun(id, supplementalRetry.runId, {
        model: supplementalRetry.model.model,
        model_provider: supplementalRetry.model.model_provider,
        harness: supplementalRetry.model.harness,
        thinking_effort: supplementalRetry.model.thinking_effort,
      });
      setSupplementalRuns((current) => [
        createdRun,
        ...(current || []).filter((run) => String(run.id) !== String(createdRun.id)),
      ]);
      setSupplementalRetry(null);
      reloadSupplementalRuns();
      reloadVulns();
    } catch (retryError) {
      setSupplementalRetryError(retryError);
    } finally {
      setSupplementalRetrySubmitting(false);
    }
  };

  return (
    <Page>
      <PageHeader
        title={scan.repoDisplay || scan.repoFull}
        badge={
          <>
            <span className="chip">{scan.repoKind === 'local' ? 'Local snapshot' : 'Remote'}</span>
            <StatusBadge status={scan.status} reasoning={scan.reasoning} size="sm" />
          </>
        }
        meta={
          <span
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              alignItems: 'baseline',
              columnGap: 'var(--space-5)',
              rowGap: 'var(--space-2)',
            }}
          >
            <span>{scan.workflowName}</span>
            <span>
              Scan <span className="mono">#{scan.id}</span>
            </span>
            {scan.modelProvider && (
              <span className="mono" style={{ fontSize: 'var(--text-xs)' }}>
                {scan.modelProvider}
              </span>
            )}
            <span className="mono" style={{ fontSize: 'var(--text-xs)' }}>
              {scan.model}
            </span>
            <span className="mono" style={{ fontSize: 'var(--text-xs)' }}>
              {scan.harness}
            </span>
            {scan.thinkingEffort && (
              <span className="mono" style={{ fontSize: 'var(--text-xs)' }}>
                {scan.thinkingEffort}
              </span>
            )}
            {modelOverrideCount > 0 && (
              <span>
                {modelOverrideCount} depth override{modelOverrideCount === 1 ? '' : 's'}
              </span>
            )}
            <span className="mono" style={{ fontSize: 'var(--text-xs)' }}>
              {scan.repoKind === 'local' ? 'local snapshot' : `@${scan.commitShort}`}
            </span>
          </span>
        }
        actions={
          <div className="page-actions" style={{ justifyContent: 'flex-end' }}>
            <Button
              variant="subtle"
              onClick={exportFindings}
              disabled={!exportAvailability.ready || busy || exporting}
              title={exportAvailability.message}
            >
              {exporting ? 'Exporting…' : 'Export findings'}
            </Button>
            <Button variant="ghost" to={duplicateScanPath(scan.id)} title="Create a new scan from this configuration">
              Duplicate scan
            </Button>
            {actions.canDelete && (
              <Button
                variant="danger"
                onClick={() => !busy && !exporting && deleteScan()}
                disabled={busy || exporting || activeSupplementalRuns.length > 0}
                title={
                  activeSupplementalRuns.length
                    ? 'Wait for supplemental post-script work to finish before deleting this scan.'
                    : undefined
                }
              >
                Delete
              </Button>
            )}
            {actions.canPause && (
              <Button variant="subtle" onClick={() => !busy && setStatus('paused')}>
                {busy ? '…' : 'Pause'}
              </Button>
            )}
            {actions.canStop && (
              <Button variant="danger" onClick={() => !busy && setStatus('stopped')}>
                {busy ? '…' : actions.stopLabel}
              </Button>
            )}
            {actions.canResume && (
              <Button
                variant="primary"
                onClick={() => !busy && setStatus('pending')}
                disabled={busy || activeSupplementalRuns.length > 0}
                title={
                  activeSupplementalRuns.length
                    ? 'Wait for supplemental post-script work to finish before resuming.'
                    : 'Continue from completed steps and retry failed work'
                }
              >
                {busy ? '…' : 'Resume'}
              </Button>
            )}
          </div>
        }
      />

      {actionError && (
        <div style={{ marginBottom: 'var(--space-6)' }}>
          <ErrorState error={actionError} />
        </div>
      )}

      <ResourceNotice notice={scan.resourceNotice} />
      <ResourceNotice notice={storageWarning} />

      {providerAutoscale && (
        <div
          style={{
            marginTop: 'var(--space-4)',
            padding: 'var(--space-4) var(--space-5)',
            borderRadius: 'var(--radius-sm)',
            background: 'var(--run-bg)',
            color: 'var(--text-2)',
            fontSize: 'var(--text-sm)',
            lineHeight: 1.5,
          }}
        >
          <strong style={{ color: 'var(--run)', fontWeight: 600 }}>Workers adjusted.</strong>{' '}
          {providerAutoscale.message}
        </div>
      )}

      {scan.status === 'rate_limited' && (
        <div
          style={{
            marginTop: 'var(--space-4)',
            padding: 'var(--space-4) var(--space-5)',
            borderRadius: 'var(--radius-sm)',
            background: 'var(--pend-bg)',
            color: 'var(--pend)',
            fontSize: 'var(--text-sm)',
            lineHeight: 1.5,
          }}
        >
          {rateLimit.accountRelated ? (
            <Link to="/accounts" style={{ color: 'inherit', fontWeight: 600 }}>
              {rateLimit.label}.
            </Link>
          ) : (
            <strong>{rateLimit.label}.</strong>
          )}{' '}
          {rateLimit.message} {rateLimitRetryText(scan.reasoning)} Completed work is preserved.
          {rateLimit.accountRelated && (
            <div style={{ marginTop: 'var(--space-2)' }}>
              <Link to="/accounts" style={{ color: 'inherit', fontWeight: 600 }}>
                View usage and provider limits in Accounts
              </Link>
            </div>
          )}
        </div>
      )}

      {scan.status === 'stopped' && scan.reasoning?.code === 'job_limit_reached' && (
        <div
          style={{
            marginTop: 'var(--space-4)',
            padding: 'var(--space-4) var(--space-5)',
            borderRadius: 'var(--radius-sm)',
            background: 'var(--pend-bg)',
            color: 'var(--pend)',
            fontSize: 'var(--text-sm)',
            lineHeight: 1.5,
          }}
        >
          This scan reached its {scan.reasoning.limit}-job limit after starting {scan.reasoning.used} jobs. Increase or
          remove the limit in Run config, then resume.
        </div>
      )}

      <div style={{ marginTop: 'var(--space-6)' }}>
        <FigureStrip>
          <Figure label="Raw candidates" value={scan.rawCandidates ?? scan.findings} />
          <Figure label="Findings listed" value={scan.findings} tone="accent" />
          <Figure label="Duplicates" value={scan.duplicateFindings ?? 0} />
          <Figure label="Exploitable" value={scan.exploitable} tone="fail" />
          <Figure label="Post-scripts" value={postScripts.length} />
          <Figure label="Agent skills" value={scan.agentSkillCount || 0} />
          <Figure
            label={scan.repoKind === 'local' ? 'Revision' : 'Commit'}
            value={
              <span className="mono" style={{ fontSize: 'var(--text-md)' }}>
                {scan.repoKind === 'local' ? 'local snapshot' : scan.commitShort}
              </span>
            }
          />
        </FigureStrip>
      </div>

      <div style={{ display: 'grid', gap: 'var(--space-9)', marginTop: 'var(--space-9)' }}>
        <EvidenceArchives key={panelKeys.evidenceArchives} scanId={id} />

        {postScripts.length > 0 && <ConfiguredPostScripts postScripts={postScripts} />}

        <ScanRunSettings
          scan={scan}
          onSave={saveRunSettings}
          references={modelReferences}
          referencesLoading={modelReferencesLoading}
          referencesError={modelReferencesError}
          catalogError={modelReferences?.catalogError}
          onRetryReferences={reloadModelReferences}
        />

        <ScanStatusPanel scan={scan} />

        <SelfImprovementPanel key={panelKeys.selfImprovement} scan={scan} references={modelReferences} />

        {agentSkills.length > 0 && <ConfiguredAgentSkills agentSkills={agentSkills} />}

        {extraEntries.length > 0 && (
          <section>
            <div className="section-head">
              <div>
                <h2>Extras</h2>
                <p className="panel-note">
                  {extraEntries.length} value
                  {extraEntries.length === 1 ? '' : 's'}
                </p>
              </div>
              <button
                type="button"
                className="btn btn--quiet btn--sm"
                aria-expanded={extrasOpen}
                aria-controls="scan-extra-values"
                onClick={() => setExtrasOpen((open) => !open)}
              >
                {extrasOpen ? 'Hide' : 'Show'}
              </button>
            </div>
            {extrasOpen && (
              <div className="table-wrap" id="scan-extra-values" style={{ maxHeight: 320, overflowY: 'auto' }}>
                <table className="data-table">
                  <thead>
                    <tr>
                      <th style={{ width: '34%' }}>Key</th>
                      <th>Value</th>
                    </tr>
                  </thead>
                  <tbody>
                    {extraEntries.map(([k, v]) => (
                      <tr key={k}>
                        <td className="mono" style={{ fontSize: 'var(--text-xs)', verticalAlign: 'top' }}>
                          extra.{k}
                        </td>
                        <td
                          className="mono"
                          style={{ fontSize: 'var(--text-xs)', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}
                        >
                          {formatExtraValue(v)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        )}

        {Array.isArray(scan.dependencies) && scan.dependencies.length > 0 && (
          <section>
            <div className="section-head">
              <h2>Dependencies</h2>
            </div>
            <div className="table-wrap">
              <table className="data-table">
                <tbody>
                  {scan.dependencies.map((d, i) => (
                    <tr key={i}>
                      <td style={{ width: '12%' }}>
                        <span className="chip">{d.kind === 'local' ? 'Local' : 'Remote'}</span>
                      </td>
                      <td className="mono" style={{ fontSize: 'var(--text-xs)' }}>
                        {d.display || d.repoFull}
                      </td>
                      <td className="mono" style={{ fontSize: 'var(--text-xs)', color: 'var(--text-3)' }}>
                        {d.kind === 'remote' && d.commitSha ? `@${d.commitSha}` : 'local snapshot'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}

        <section>
          <div className="section-head">
            <div>
              <h2>Vulnerabilities</h2>
              <p className="panel-note">
                Ranked by the scan’s severity ranker and enriched by post-scripts. Click a finding for the full trace.
              </p>
            </div>
          </div>

          <div style={{ marginTop: 'var(--space-5)' }}>
            {/* prettier-ignore */}
            <SupplementalPostScriptControls
              availability={supplementalAvailability}
              mode={supplementalMode}
              onBegin={beginSupplementalRun}
              onCancel={cancelSupplementalRun}
              selectedCount={selectedCount}
              totalCount={list.length}
              allSelected={allFindingsSelected}
              onToggleAll={toggleAllFindingSelection}
              postScripts={availablePostScripts || []}
              postScriptsLoading={availablePostScriptsLoading}
              postScriptsError={availablePostScriptsError}
              onRetryPostScripts={reloadAvailablePostScripts}
              selectedPostScriptId={supplementalPostScriptId}
              onSelectPostScript={chooseSupplementalPostScript}
              requiredExtraKeys={supplementalExtraKeys}
              extra={supplementalExtra}
              onExtraChange={(key, value) => setSupplementalExtra((current) => ({ ...current, [key]: value }))}
              model={supplementalModel}
              onModelChange={setSupplementalModel}
              modelReferences={modelReferences}
              modelReferencesLoading={modelReferencesLoading}
              modelReferencesError={modelReferencesError}
              submitting={supplementalSubmitting}
              error={supplementalError}
              onSubmit={submitSupplementalRun}
              runs={supplementalRuns || []}
              runsError={supplementalRunsError}
              findings={list}
              scanId={id}
              retry={supplementalRetry}
              onBeginRetry={beginSupplementalRetry}
              onCancelRetry={() => {
                setSupplementalRetry(null);
                setSupplementalRetryError(null);
              }}
              onRetryModelChange={(model) => setSupplementalRetry((current) => (current ? { ...current, model } : null))}
              onSubmitRetry={submitSupplementalRetry}
              retrySubmitting={supplementalRetrySubmitting}
              retryError={supplementalRetryError}
            />
          </div>

          {reviewError && (
            <div
              role="alert"
              style={{
                marginTop: 'var(--space-5)',
                padding: 'var(--space-4) var(--space-5)',
                borderRadius: 'var(--radius-sm)',
                color: 'var(--fail)',
                background: 'var(--fail-bg)',
                fontSize: 'var(--text-sm)',
                lineHeight: 1.5,
              }}
            >
              Could not save the review change. The latest server value is being reloaded. {reviewError.message}
            </div>
          )}

          <div style={{ marginTop: 'var(--space-5)' }}>
            {vulnsLoading && !vulns ? (
              <Spinner label="Loading vulnerabilities…" />
            ) : vulnsError ? (
              <ErrorState error={vulnsError} onRetry={reloadVulns} />
            ) : list.length === 0 ? (
              <div className="state-block">
                <div className="state-note">
                  {scan.status === 'completed' || scan.status === 'stopped'
                    ? 'No vulnerabilities were reported for this scan.'
                    : 'Findings will appear here once the scan completes.'}
                </div>
              </div>
            ) : (
              <>
                <div className="table-wrap">
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>
                          {supplementalMode ? (
                            <label
                              style={{
                                display: 'inline-flex',
                                alignItems: 'center',
                                gap: 'var(--space-3)',
                                cursor: 'pointer',
                              }}
                            >
                              <input
                                className="checkbox"
                                type="checkbox"
                                checked={allFindingsSelected}
                                onChange={toggleAllFindingSelection}
                                aria-label="Select all findings"
                              />
                              Finding
                            </label>
                          ) : (
                            'Finding'
                          )}
                        </th>
                        <th>Interesting</th>
                        <th>Severity</th>
                        <th>Post</th>
                        <th>Actor / Type</th>
                      </tr>
                    </thead>
                    <tbody>
                      {findingPages.pageItems.map((v) => {
                        const chips = extractChips(v);
                        const interesting = v.interesting ?? null;
                        const title = interestingTitle(interesting);
                        const severity = findingSeverity(v);
                        const supplementalSummary = supplementalFindingRunSummary(v, supplementalRuns || []);
                        return (
                          <tr
                            key={v.id}
                            style={{
                              // Row color is the interesting indicator: highlight when interesting,
                              // mute the text when explicitly not interesting.
                              background: interesting === 1 ? 'var(--accent-subtle)' : undefined,
                            }}
                          >
                            <td style={{ minWidth: 260 }}>
                              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 'var(--space-4)' }}>
                                {supplementalMode && (
                                  <input
                                    className="checkbox"
                                    type="checkbox"
                                    checked={selectedFindingIds.has(v.id)}
                                    onClick={(event) => event.stopPropagation()}
                                    onChange={() => toggleFindingSelection(v.id)}
                                    aria-label={`Select finding ${v.rank}`}
                                    style={{ marginTop: 'var(--space-1)', flex: 'none' }}
                                  />
                                )}
                                <span
                                  className="mono"
                                  style={{
                                    width: 30,
                                    flex: 'none',
                                    color: 'var(--text-3)',
                                    fontSize: 'var(--text-xs)',
                                    lineHeight: 1.45,
                                  }}
                                >
                                  #{v.rank}
                                </span>
                                <div style={{ minWidth: 0 }}>
                                  <Link
                                    className="cell-main"
                                    to={`/scans/${id}/vulnerabilities/${v.id}`}
                                    aria-label={`Open finding ${v.rank}: ${v.summary}`}
                                    title={v.summary}
                                    style={interesting === 0 ? { color: 'var(--text-3)' } : undefined}
                                  >
                                    {v.summary}
                                  </Link>
                                  <div
                                    style={{
                                      display: 'flex',
                                      alignItems: 'center',
                                      gap: 'var(--space-3)',
                                      marginTop: 'var(--space-1)',
                                      minWidth: 0,
                                      color: 'var(--text-3)',
                                      fontSize: 'var(--text-xs)',
                                    }}
                                  >
                                    <span
                                      className="mono"
                                      title={`${v.file_path}:${v.line}`}
                                      style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                                    >
                                      {v.file_path}:{v.line}
                                    </span>
                                    {v.comments && v.comments.trim() && (
                                      <span title="Has a comment" style={{ flex: 'none' }}>
                                        ✎
                                      </span>
                                    )}
                                    {supplementalSummary.count > 0 && (
                                      <span
                                        className="chip"
                                        title={`${supplementalSummary.count} supplemental post-script run${
                                          supplementalSummary.count === 1 ? '' : 's'
                                        }${supplementalSummary.active ? `, ${supplementalSummary.active} active` : ''}${
                                          supplementalSummary.failed ? `, ${supplementalSummary.failed} failed` : ''
                                        }`}
                                        style={{
                                          flex: 'none',
                                          color: supplementalSummary.failed ? 'var(--pend)' : 'var(--accent-strong)',
                                        }}
                                      >
                                        +post ×{supplementalSummary.count}
                                        {supplementalSummary.active ? ' (running)' : ''}
                                      </span>
                                    )}
                                  </div>
                                </div>
                              </div>
                            </td>
                            <td>
                              <button
                                type="button"
                                onClick={(e) => cycleInteresting(v, e)}
                                title={title}
                                aria-pressed={interesting === 1}
                                className="btn btn--quiet btn--sm"
                              >
                                {interesting === 1 ? 'Interesting' : interesting === 0 ? 'Not interesting' : 'Unmarked'}
                              </button>
                            </td>
                            <td>
                              <span
                                className="status"
                                title={severity || 'Unrated'}
                                style={{
                                  maxWidth: '100%',
                                  background: 'var(--surface-2)',
                                  color: sevColor(severity),
                                  overflow: 'hidden',
                                  textOverflow: 'ellipsis',
                                }}
                              >
                                {severity || 'Unrated'}
                              </span>
                            </td>
                            <td>
                              <ChipList chips={chips} fallback={postOutputSummary(v)} />
                            </td>
                            <td>
                              <FindingActorTypeCell
                                maliciousActor={v.malicious_actor}
                                vulnerabilityType={v.vulnerability_type}
                              />
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                <div style={{ marginTop: 'var(--space-4)' }}>
                  <Pagination {...findingPages} itemLabel="findings" />
                </div>
              </>
            )}
          </div>
        </section>
      </div>
    </Page>
  );
}

export function SupplementalPostScriptControls({
  availability,
  mode,
  onBegin,
  onCancel,
  selectedCount,
  totalCount,
  allSelected,
  onToggleAll,
  postScripts,
  postScriptsLoading,
  postScriptsError,
  onRetryPostScripts,
  selectedPostScriptId,
  onSelectPostScript,
  requiredExtraKeys,
  extra,
  onExtraChange,
  model,
  onModelChange,
  modelReferences,
  modelReferencesLoading,
  modelReferencesError,
  submitting,
  error,
  onSubmit,
  runs,
  runsError,
  findings,
  scanId,
  retry,
  onBeginRetry,
  onCancelRetry,
  onRetryModelChange,
  onSubmitRetry,
  retrySubmitting,
  retryError,
}) {
  const visible = mode || availability.ready || runs.length > 0 || runsError;
  if (!visible) return null;
  const modelValid =
    !!model &&
    !!modelReferences &&
    modelConfigurationIsValid(model, modelReferences.providers, modelReferences.catalog);
  const retryModelValid =
    !!retry?.model &&
    !!modelReferences &&
    modelConfigurationIsValid(retry.model, modelReferences.providers, modelReferences.catalog);
  const findingsById = new Map((findings || []).map((finding) => [String(finding.id), finding]));
  const retriedRunIds = new Set(
    (runs || [])
      .map((run) => run.retryOfRunId)
      .filter(Boolean)
      .map(String)
  );

  return (
    <section aria-label="Additional post-processing">
      <div
        style={{
          display: 'flex',
          alignItems: 'flex-start',
          justifyContent: 'space-between',
          flexWrap: 'wrap',
          gap: 'var(--space-4)',
        }}
      >
        <div>
          <div className="setting-label">Additional post-processing</div>
          <div className="panel-note">
            {mode
              ? `${selectedCount} of ${totalCount} findings selected`
              : 'Apply a post-script to selected findings without resuming the scan.'}
          </div>
        </div>
        {!mode ? (
          <Button variant="subtle" onClick={onBegin} disabled={!availability.ready} title={availability.message}>
            Run post-script on findings
          </Button>
        ) : (
          <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
            <Button variant="ghost" onClick={onToggleAll} disabled={submitting}>
              {allSelected ? 'Clear selection' : 'Select all'}
            </Button>
            <Button variant="ghost" onClick={onCancel} disabled={submitting}>
              Cancel
            </Button>
          </div>
        )}
      </div>

      {mode && (
        <div style={{ marginTop: 'var(--space-6)', display: 'grid', gap: 'var(--space-6)' }}>
          <label className="field" style={{ maxWidth: 360 }}>
            <span className="field-label">Post-script</span>
            <select
              value={selectedPostScriptId}
              onChange={(event) => onSelectPostScript(event.target.value)}
              disabled={submitting || postScriptsLoading}
              className="select"
            >
              <option value="">{postScriptsLoading ? 'Loading post-scripts…' : 'Choose a post-script'}</option>
              {postScripts.map((postScript) => (
                <option key={postScript.id} value={postScript.id}>
                  {postScript.name}
                </option>
              ))}
            </select>
          </label>
          {postScriptsError && (
            <div className="field-error" role="alert">
              Could not load post-scripts. {postScriptsError.message}{' '}
              <button
                type="button"
                onClick={onRetryPostScripts}
                style={{ color: 'inherit', textDecoration: 'underline', cursor: 'pointer' }}
              >
                Try again
              </button>
            </div>
          )}
          <div>
            <div className="field-label">Execution model</div>
            <div className="panel-note" style={{ margin: 'var(--space-1) 0 var(--space-4)' }}>
              Prefilled from this scan&apos;s post-processing settings. Changes apply only to this supplemental run.
            </div>
            {modelReferencesLoading || !modelReferences || !model ? (
              <div
                style={{
                  color: modelReferencesError ? 'var(--fail)' : 'var(--text-3)',
                  fontSize: 'var(--text-xs)',
                }}
              >
                {modelReferencesError ? formatApiError(modelReferencesError) : 'Loading model choices…'}
              </div>
            ) : (
              <ModelConfiguration
                value={model}
                onChange={onModelChange}
                providers={modelReferences.providers}
                catalog={modelReferences.catalog}
                catalogError={modelReferences.catalogError}
                disabled={submitting}
                showAvailabilityHelp={false}
              />
            )}
          </div>
          {requiredExtraKeys.length > 0 && (
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
                gap: 'var(--space-5)',
              }}
            >
              {requiredExtraKeys.map((key) => (
                <label key={key} className="field">
                  <span className="field-label" style={{ justifyContent: 'flex-start' }}>
                    <span className="mono">extra.{key}</span>
                    <span style={{ color: 'var(--fail)' }}>*</span>
                  </span>
                  <input
                    value={extra[key] ?? ''}
                    onChange={(event) => onExtraChange(key, event.target.value)}
                    disabled={submitting}
                    required
                    className="input"
                    placeholder={`Value for extra.${key}`}
                  />
                </label>
              ))}
            </div>
          )}
          {error && (
            <div className="field-error" role="alert">
              {formatApiError(error)}
            </div>
          )}
          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <Button
              onClick={onSubmit}
              disabled={submitting || selectedCount === 0 || !selectedPostScriptId || postScriptsLoading || !modelValid}
            >
              {submitting ? 'Queuing…' : `Queue for ${selectedCount} finding${selectedCount === 1 ? '' : 's'}`}
            </Button>
          </div>
        </div>
      )}

      {(runs.length > 0 || runsError) && (
        <div style={{ marginTop: 'var(--space-6)' }}>
          <div className="field-label" style={{ marginBottom: 'var(--space-2)' }}>
            Supplemental run history
          </div>
          {runsError ? (
            <div className="field-error">{runsError.message}</div>
          ) : (
            <div>
              {runs.map((run) => {
                const progress = run.targetCount
                  ? Math.round(((run.completedCount + run.failedCount) / run.targetCount) * 100)
                  : 0;
                const failedTargets = (run.targets || []).filter((target) => target.status === 'failed');
                const retrying = String(retry?.runId) === String(run.id);
                const wasRetried = retriedRunIds.has(String(run.id));
                const statusColor =
                  run.status === 'completed'
                    ? 'var(--ok)'
                    : run.status === 'completed_with_errors'
                      ? 'var(--pend)'
                      : 'var(--run)';
                return (
                  <div key={run.id} style={{ padding: 'var(--space-4) 0', borderTop: '1px solid var(--border-2)' }}>
                    <div style={{ display: 'flex', alignItems: 'baseline', flexWrap: 'wrap', gap: 'var(--space-4)' }}>
                      <span style={{ color: statusColor, fontSize: 'var(--text-sm)', fontWeight: 500 }}>
                        {run.status.replaceAll('_', ' ')}
                      </span>
                      <span
                        style={{
                          flex: 1,
                          minWidth: 0,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                          fontSize: 'var(--text-sm)',
                        }}
                      >
                        {run.postScriptName}
                      </span>
                      <span className="mono" style={{ color: 'var(--text-3)', fontSize: 'var(--text-xs)' }}>
                        {run.completedCount + run.failedCount}/{run.targetCount} ({progress}%)
                        {run.failedCount ? `, ${run.failedCount} failed` : ''}
                      </span>
                    </div>
                    <div
                      style={{
                        display: 'flex',
                        flexWrap: 'wrap',
                        gap: 'var(--space-2) var(--space-4)',
                        marginTop: 'var(--space-2)',
                        color: 'var(--text-3)',
                        fontSize: 'var(--text-xs)',
                      }}
                    >
                      {run.modelProvider && run.model ? (
                        <>
                          <span className="mono">{run.modelProvider}</span>
                          <span className="mono">{run.model}</span>
                          <span>{run.harness || 'default harness'}</span>
                          <span>{run.thinkingEffort || 'default effort'}</span>
                        </>
                      ) : (
                        <span>Scan post-processing model</span>
                      )}
                    </div>
                    {failedTargets.length > 0 && (
                      <>
                        <details style={{ marginTop: 'var(--space-3)' }}>
                          <summary
                            style={{
                              color: 'var(--fail)',
                              cursor: 'pointer',
                              fontWeight: 500,
                              fontSize: 'var(--text-xs)',
                            }}
                          >
                            View {failedTargets.length} error{failedTargets.length === 1 ? '' : 's'}
                          </summary>
                          <div
                            style={{
                              display: 'grid',
                              gap: 'var(--space-3)',
                              maxHeight: 280,
                              overflowY: 'auto',
                              marginTop: 'var(--space-3)',
                            }}
                          >
                            {failedTargets.map((target) => {
                              const finding = findingsById.get(String(target.vulnerabilityId));
                              return (
                                <div key={target.id}>
                                  <Link
                                    to={`/scans/${scanId}/vulnerabilities/${target.vulnerabilityId}`}
                                    style={{ color: 'var(--text)', fontWeight: 500 }}
                                  >
                                    {finding
                                      ? `Finding #${finding.rank}: ${finding.summary}`
                                      : `Finding ${target.vulnerabilityId}`}
                                  </Link>
                                  <div
                                    className="mono"
                                    style={{
                                      marginTop: 'var(--space-1)',
                                      color: 'var(--fail)',
                                      fontSize: 'var(--text-xs)',
                                      whiteSpace: 'pre-wrap',
                                      overflowWrap: 'anywhere',
                                    }}
                                  >
                                    {target.error || 'The worker did not record an error message.'}
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        </details>
                        {!retrying && !wasRetried && (
                          <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 'var(--space-3)' }}>
                            <Button
                              variant="ghost"
                              onClick={() => onBeginRetry(run)}
                              disabled={retrySubmitting || !availability.ready}
                            >
                              Re-run failed
                            </Button>
                          </div>
                        )}
                        {wasRetried && (
                          <div
                            style={{
                              marginTop: 'var(--space-3)',
                              color: 'var(--text-3)',
                              fontSize: 'var(--text-xs)',
                              textAlign: 'right',
                            }}
                          >
                            Failed findings were re-run.
                          </div>
                        )}
                      </>
                    )}
                    {retrying && (
                      <div
                        style={{
                          marginTop: 'var(--space-4)',
                          paddingTop: 'var(--space-4)',
                          borderTop: '1px solid var(--border-2)',
                        }}
                      >
                        <div
                          style={{
                            marginBottom: 'var(--space-4)',
                            color: 'var(--text-2)',
                            fontSize: 'var(--text-xs)',
                            lineHeight: 1.5,
                          }}
                        >
                          Re-run only the {failedTargets.length} failed finding
                          {failedTargets.length === 1 ? '' : 's'}. The original script and extra values are reused; you
                          can change the execution model below.
                        </div>
                        {modelReferences && retry?.model ? (
                          <ModelConfiguration
                            value={retry.model}
                            onChange={onRetryModelChange}
                            providers={modelReferences.providers}
                            catalog={modelReferences.catalog}
                            catalogError={modelReferences.catalogError}
                            disabled={retrySubmitting}
                            showAvailabilityHelp={false}
                          />
                        ) : (
                          <div className="field-error">Model choices are not available.</div>
                        )}
                        {retryError && (
                          <div className="field-error" role="alert">
                            {formatApiError(retryError)}
                          </div>
                        )}
                        <div
                          style={{
                            display: 'flex',
                            justifyContent: 'flex-end',
                            gap: 'var(--space-2)',
                            marginTop: 'var(--space-4)',
                          }}
                        >
                          <Button variant="ghost" onClick={onCancelRetry} disabled={retrySubmitting}>
                            Cancel
                          </Button>
                          <Button onClick={onSubmitRetry} disabled={retrySubmitting || !retryModelValid}>
                            {retrySubmitting ? 'Queuing…' : `Queue retry for ${failedTargets.length}`}
                          </Button>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function ScanRunSettings({
  scan,
  onSave,
  references,
  referencesLoading,
  referencesError,
  catalogError,
  onRetryReferences,
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const current = runSettingsDraft(scan);
  const activeDraft = mergeRunSettingsDraft(current, draft);
  const payload = draft ? runSettingsPayload(draft, current) : {};
  const dirty = Object.keys(payload).length > 0;
  const workflowDepths = Array.isArray(scan.workflowDepths)
    ? scan.workflowDepths
    : Object.keys(current.model_overrides).map(Number);
  const jobLimit = activeDraft.job_limit.trim();
  const jobLimitValid = !jobLimit || (/^\d+$/.test(jobLimit) && Number(jobLimit) >= 1 && Number(jobLimit) <= 1_000_000);
  const valid =
    jobLimitValid &&
    !!references &&
    workflowModelConfigurationIsValid(activeDraft, workflowDepths, references.providers, references.catalog);
  useUnsavedChangesPrompt(editing && (dirty || saving));

  const open = () => {
    const currentDraft = runSettingsDraft(scan);
    const reconciledDraft = {
      ...currentDraft,
      model_overrides: reconcileModelOverrides(currentDraft.model_overrides, workflowDepths, currentDraft),
    };
    setDraft(
      references
        ? mergeRunSettingsDraft(
            reconciledDraft,
            workflowModelConfigurationForCatalog(reconciledDraft, references.providers, references.catalog)
          )
        : reconciledDraft
    );
    setError(null);
    setEditing(true);
  };
  const cancel = () => {
    setEditing(false);
    setDraft(null);
    setError(null);
  };
  const save = async () => {
    if (!valid) {
      setError(
        jobLimitValid
          ? 'Choose a configured provider, available model, supported thinking effort, and compatible harness.'
          : 'Maximum model jobs must be a whole number from 1 to 1,000,000.'
      );
      return;
    }
    if (!dirty) {
      cancel();
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onSave(payload);
      setEditing(false);
      setDraft(null);
    } catch (e) {
      setError(formatApiError(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <section>
      <div className="section-head">
        <div>
          <h2>Run config</h2>
          {!editing && (
            <p
              className="panel-note"
              style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-2) var(--space-4)' }}
            >
              {current.model_provider && <span className="mono">{current.model_provider}</span>}
              <span className="mono">{current.model}</span>
              <span className="mono">{current.harness}</span>
              {current.thinking_effort && <span className="mono">{current.thinking_effort}</span>}
            </p>
          )}
        </div>
        {editing ? (
          <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
            <Button variant="ghost" disabled={saving} onClick={cancel}>
              Cancel
            </Button>
            <Button variant="primary" disabled={saving || !valid || !dirty} onClick={save}>
              {saving ? 'Saving…' : 'Save'}
            </Button>
          </div>
        ) : (
          <Button variant="ghost" onClick={open} disabled={referencesLoading || !!referencesError || !references}>
            Edit
          </Button>
        )}
      </div>

      {editing ? (
        <div style={{ marginTop: 'var(--space-5)', display: 'grid', gap: 'var(--space-5)' }}>
          <WorkflowModelConfiguration
            value={activeDraft}
            onChange={(nextDraft) =>
              setDraft((currentDraft) => mergeRunSettingsDraft(currentDraft || current, nextDraft))
            }
            providers={references?.providers || []}
            catalog={references?.catalog || {}}
            catalogError={catalogError}
            disabled={saving}
            depths={workflowDepths}
          />
          <label className="field" style={{ maxWidth: 280 }}>
            <span className="field-label">
              Maximum model jobs
              <span className="field-unit">optional</span>
            </span>
            <input
              className="input mono"
              type="number"
              min="1"
              max="1000000"
              step="1"
              placeholder="unlimited"
              value={activeDraft.job_limit}
              disabled={saving}
              aria-invalid={!jobLimitValid}
              onChange={(event) =>
                setDraft((currentDraft) => ({
                  ...currentDraft,
                  job_limit: event.target.value,
                }))
              }
            />
            <span className="field-note">
              {scan.jobsStarted || 0} logical jobs started. Internal retries do not consume extra jobs.
            </span>
          </label>
          {error && <div className="field-error">{error}</div>}
        </div>
      ) : referencesError ? (
        <div style={{ marginTop: 'var(--space-5)' }}>
          <ErrorState error={referencesError} onRetry={onRetryReferences} />
        </div>
      ) : (
        <div style={{ marginTop: 'var(--space-4)' }}>
          <RuntimeSetting label="Model" value={current.model} />
          <RuntimeSetting label="Model provider" value={current.model_provider || '—'} />
          <RuntimeSetting label="Thinking effort" value={current.thinking_effort || '—'} />
          <RuntimeSetting label="Harness" value={current.harness} />
          <RuntimeSetting label="Post model" value={current.post_processing_model || '—'} />
          <RuntimeSetting label="Post provider" value={current.post_processing_model_provider || '—'} />
          <RuntimeSetting label="Post effort" value={current.post_processing_thinking_effort || '—'} />
          <RuntimeSetting label="Post harness" value={current.post_processing_harness || '—'} />
          <RuntimeSetting label="Depth overrides" value={Object.keys(current.model_overrides).length || 'none'} />
          <RuntimeSetting
            label="Model jobs"
            value={`${scan.jobsStarted || 0} / ${scan.jobLimit == null ? 'unlimited' : scan.jobLimit}`}
          />
        </div>
      )}
    </section>
  );
}

export function runSettingsDraft(scan = {}) {
  return {
    model: scan.model || '',
    model_provider: scan.modelProvider || 'openrouter',
    thinking_effort: scan.thinkingEffort || 'medium',
    post_processing_model_override: Boolean(scan.postProcessingModelOverride),
    post_processing_model: scan.postProcessingModel || scan.model || '',
    post_processing_model_provider: scan.postProcessingModelProvider || scan.modelProvider || 'openrouter',
    post_processing_harness: scan.postProcessingHarness || scan.harness || 'codex',
    post_processing_thinking_effort: scan.postProcessingThinkingEffort || scan.thinkingEffort || 'medium',
    harness: scan.harness || 'codex',
    model_overrides: modelOverridesDraft(scan.modelOverrides),
    job_limit: scan.jobLimit == null ? '' : `${scan.jobLimit}`,
  };
}

function runSettingsValue(value, fallback) {
  if (value === undefined) return fallback;
  if (value === null) return '';
  return typeof value === 'string' ? value : String(value);
}

export function mergeRunSettingsDraft(current = {}, patch = {}) {
  const hasModelOverrides = Object.prototype.hasOwnProperty.call(patch || {}, 'model_overrides');
  const hasPostProcessingModelOverride = Object.prototype.hasOwnProperty.call(
    patch || {},
    'post_processing_model_override'
  );
  const base = {
    model: runSettingsValue(current?.model, ''),
    model_provider: runSettingsValue(current?.model_provider, 'openrouter'),
    thinking_effort: runSettingsValue(current?.thinking_effort, 'medium'),
    post_processing_model_override: Boolean(current?.post_processing_model_override),
    post_processing_model: runSettingsValue(current?.post_processing_model, current?.model || ''),
    post_processing_model_provider: runSettingsValue(
      current?.post_processing_model_provider,
      current?.model_provider || 'openrouter'
    ),
    post_processing_harness: runSettingsValue(current?.post_processing_harness, current?.harness || 'codex'),
    post_processing_thinking_effort: runSettingsValue(
      current?.post_processing_thinking_effort,
      current?.thinking_effort || 'medium'
    ),
    harness: runSettingsValue(current?.harness, 'codex'),
    model_overrides: modelOverridesDraft(current?.model_overrides),
    job_limit: runSettingsValue(current?.job_limit, ''),
  };
  return {
    model: runSettingsValue(patch?.model, base.model),
    model_provider: runSettingsValue(patch?.model_provider, base.model_provider),
    thinking_effort: runSettingsValue(patch?.thinking_effort, base.thinking_effort),
    post_processing_model_override: hasPostProcessingModelOverride
      ? Boolean(patch.post_processing_model_override)
      : base.post_processing_model_override,
    post_processing_model: runSettingsValue(patch?.post_processing_model, base.post_processing_model),
    post_processing_model_provider: runSettingsValue(
      patch?.post_processing_model_provider,
      base.post_processing_model_provider
    ),
    post_processing_harness: runSettingsValue(patch?.post_processing_harness, base.post_processing_harness),
    post_processing_thinking_effort: runSettingsValue(
      patch?.post_processing_thinking_effort,
      base.post_processing_thinking_effort
    ),
    harness: runSettingsValue(patch?.harness, base.harness),
    model_overrides: hasModelOverrides ? modelOverridesDraft(patch.model_overrides) : base.model_overrides,
    job_limit: runSettingsValue(patch?.job_limit, base.job_limit),
  };
}

export function runSettingsPayload(draft, current) {
  const normalizedCurrent = mergeRunSettingsDraft({}, current);
  const normalizedDraft = mergeRunSettingsDraft(normalizedCurrent, draft);
  const payload = {};
  const model = normalizedDraft.model.trim();
  const jobLimit = normalizedDraft.job_limit.trim();
  if (model !== normalizedCurrent.model) payload.model = model;
  if (normalizedDraft.model_provider !== normalizedCurrent.model_provider)
    payload.model_provider = normalizedDraft.model_provider;
  if (normalizedDraft.thinking_effort !== normalizedCurrent.thinking_effort)
    payload.thinking_effort = normalizedDraft.thinking_effort;
  const postProcessingModelChanged =
    normalizedDraft.post_processing_model !== normalizedCurrent.post_processing_model ||
    normalizedDraft.post_processing_model_provider !== normalizedCurrent.post_processing_model_provider ||
    normalizedDraft.post_processing_harness !== normalizedCurrent.post_processing_harness;
  if (normalizedDraft.post_processing_model_override) {
    if (!normalizedCurrent.post_processing_model_override || postProcessingModelChanged) {
      payload.post_processing_model = normalizedDraft.post_processing_model.trim();
      payload.post_processing_model_provider = normalizedDraft.post_processing_model_provider;
      payload.post_processing_harness = normalizedDraft.post_processing_harness;
    }
  } else if (normalizedCurrent.post_processing_model_override) {
    payload.post_processing_model = null;
    payload.post_processing_model_provider = null;
    payload.post_processing_harness = null;
  }
  if (normalizedDraft.post_processing_thinking_effort !== normalizedCurrent.post_processing_thinking_effort)
    payload.post_processing_thinking_effort = normalizedDraft.post_processing_thinking_effort;
  if (normalizedDraft.harness !== normalizedCurrent.harness) payload.harness = normalizedDraft.harness;
  if (!modelOverridesEqual(normalizedDraft.model_overrides, normalizedCurrent.model_overrides))
    payload.model_overrides = normalizedDraft.model_overrides;
  if (normalizedDraft.job_limit !== normalizedCurrent.job_limit) payload.jobLimit = jobLimit ? Number(jobLimit) : null;
  return payload;
}

function formatApiError(error) {
  if (error instanceof ApiError && error.errors?.length) {
    return error.errors.map((e) => `${e.field}: ${e.message}`).join(', ');
  }
  return error?.message || 'Failed to save run config.';
}

function RuntimeSetting({ label, value }) {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'minmax(140px, 0.45fr) minmax(0, 1.55fr)',
        gap: 'var(--space-5)',
        alignItems: 'baseline',
        padding: 'var(--space-3) 0',
        borderBottom: '1px solid var(--border-2)',
      }}
    >
      <span style={{ color: 'var(--text-2)', fontSize: 'var(--text-xs)' }}>{label}</span>
      <span
        className="mono"
        title={value}
        style={{
          minWidth: 0,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          fontSize: 'var(--text-xs)',
        }}
      >
        {value}
      </span>
    </div>
  );
}

function interestingTitle(intr) {
  const v = intr ?? null;
  if (v === 1) return 'Interesting, click to change';
  if (v === 0) return 'Not interesting, click to change';
  return 'Unmarked, click to flag';
}

function scanErrorTimestamp(error) {
  for (const value of [error?.updatedAt, error?.insertedAt]) {
    if (!value) continue;
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) continue;
    return {
      dateTime: date.toISOString(),
      label: new Intl.DateTimeFormat(undefined, {
        dateStyle: 'medium',
        timeStyle: 'medium',
      }).format(date),
    };
  }
  return null;
}

const EXTENDED_ACTIVE_JOB_MS = 45 * 60 * 1000;
const ACTIVE_JOB_HARNESS_LABELS = Object.freeze({
  codex: 'Codex CLI',
  'claude-code': 'Claude Code',
  'grok-build': 'Grok Build',
  droid: 'Factory Droid',
});

function activeJobHarnessLabel(value) {
  const harness = `${value || ''}`.trim();
  return ACTIVE_JOB_HARNESS_LABELS[harness] || harness || 'Not reported';
}

export function activeJobWorkflowDepth(job) {
  if (job?.kind && job.kind !== 'step') return null;
  if (job?.depth != null && job.depth !== '') {
    const explicitDepth = Number(job.depth);
    if (Number.isInteger(explicitDepth) && explicitDepth >= 0) return explicitDepth;
  }
  const titleMatch = `${job?.title || ''}`.match(/^\s*(\d+)\s*·/);
  if (!titleMatch) return null;
  const titleDepth = Number(titleMatch[1]);
  return Number.isInteger(titleDepth) ? titleDepth : null;
}

function activeJobStage(job) {
  const depth = activeJobWorkflowDepth(job);
  if (depth != null) return { key: `depth-${depth}`, label: `D${depth}`, depth };
  if (job?.kind && job.kind !== 'step') return { key: 'post', label: 'POST', depth: null };
  return { key: 'work', label: 'WORK', depth: null };
}

export function activeJobDepthSummary(jobs = []) {
  const counts = new Map();
  for (const job of jobs) {
    const stage = activeJobStage(job);
    const current = counts.get(stage.key);
    if (current) current.count += 1;
    else counts.set(stage.key, { ...stage, count: 1 });
  }
  return [...counts.values()].sort((left, right) => {
    if (left.depth != null && right.depth != null) return left.depth - right.depth;
    if (left.depth != null) return -1;
    if (right.depth != null) return 1;
    return left.label.localeCompare(right.label);
  });
}

export function formatActiveJobElapsed(value) {
  const milliseconds = Number(value);
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return null;
  const seconds = Math.floor(milliseconds / 1000);
  if (seconds < 1) return '<1s';
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
}

function ActiveJobCard({ job }) {
  const elapsed = formatActiveJobElapsed(job.elapsedMs);
  const extended = Number(job.elapsedMs) >= EXTENDED_ACTIVE_JOB_MS;
  const stage = activeJobStage(job);
  const model = `${job.model || ''}`.trim() || 'Not reported';
  const harness = activeJobHarnessLabel(job.harness);

  return (
    <tr
      aria-label={`${stage.depth == null ? stage.label : `Workflow depth ${stage.depth}`} worker: ${job.title || job.source || 'Active worker'}`}
    >
      <td style={{ minWidth: 220 }}>
        <div
          title={job.title}
          style={{
            color: 'var(--text)',
            fontSize: 'var(--text-sm)',
            fontWeight: 500,
            lineHeight: 1.35,
            overflowWrap: 'anywhere',
            whiteSpace: 'normal',
          }}
        >
          {job.title || job.source || 'Active worker'}
        </div>
        <span className="cell-sub">{job.phaseLabel || 'Running'}</span>
      </td>
      <td>
        <span className="chip chip--code" title={stage.depth == null ? stage.label : `Workflow depth ${stage.depth}`}>
          {stage.label}
        </span>
      </td>
      <td>
        <div
          className="mono"
          aria-label={`Model: ${model}; Harness: ${harness}`}
          style={{ fontSize: 'var(--text-xs)', overflowWrap: 'anywhere' }}
        >
          <span title={`Model: ${model}`}>{model}</span>
          <span className="cell-sub" title={`Harness: ${harness}`}>
            {harness}
          </span>
        </div>
      </td>
      <td
        className="cell-num"
        title={
          extended
            ? 'Extended run. This is informational and does not mean the worker is stuck or failed.'
            : 'Current active harness duration'
        }
        style={{ color: extended ? 'var(--pend)' : 'var(--text-2)', whiteSpace: 'nowrap' }}
      >
        {extended ? 'extended, ' : ''}
        {elapsed || 'starting'}
      </td>
    </tr>
  );
}

export function ScanStatusPanel({ scan }) {
  const summary = scan.statusSummary || {};
  const rateLimited = scan.status === 'rate_limited';
  const completedLineages = summary.completedStepLineages ?? summary.stepCompletedAttempts ?? 0;
  const expectedLineages = summary.expectedStepLineages ?? summary.stepAttempts ?? 0;
  const activeJobs = summary.activeJobs || [];
  const activeDepths = activeJobDepthSummary(activeJobs);
  const longestActiveJobMs = activeJobs.reduce((longest, job) => {
    const elapsed = Number(job?.elapsedMs);
    return Number.isFinite(elapsed) ? Math.max(longest, elapsed) : longest;
  }, 0);
  const recentErrors = summary.recentErrors || [];
  const currentFailedAttempts = summary.currentFailedAttempts ?? summary.failedAttempts ?? 0;
  const recentEmptyResults = summary.recentEmptyResults || [];
  const [expandedErrorIds, setExpandedErrorIds] = useState(() => new Set());
  const toggleError = (id) => {
    setExpandedErrorIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  if (!activeJobs.length && !recentErrors.length && !summary.totalAttempts) return null;

  return (
    <section>
      <div className="section-head">
        <div>
          <h2>Status</h2>
        </div>
        {summary.progress && (
          <div style={{ minWidth: 160, flex: '0 0 220px' }}>
            <div style={{ color: 'var(--text-2)', fontSize: 'var(--text-xs)', marginBottom: 'var(--space-2)' }}>
              {summary.progressLabel || 'progress'}
            </div>
            <div
              style={{
                height: 6,
                background: 'var(--surface-3)',
                borderRadius: 'var(--radius-xs)',
                overflow: 'hidden',
              }}
            >
              <div style={{ height: '100%', width: summary.progress, background: 'var(--run)' }} />
            </div>
          </div>
        )}
      </div>

      <div style={{ marginTop: 'var(--space-4)' }}>
        <FigureStrip>
          <Figure label="Workflow" value={`${completedLineages}/${expectedLineages}`} />
          <Figure label="Attempts" value={summary.totalAttempts || 0} />
          <Figure label="Running" value={summary.runningAttempts || 0} />
          <Figure label="Empty" value={summary.emptyStepResults || 0} />
          <Figure
            label={rateLimited ? 'Attempt errors' : 'Failed'}
            value={
              <span
                style={{
                  color: currentFailedAttempts ? (rateLimited ? 'var(--pend)' : 'var(--fail)') : 'var(--text)',
                }}
              >
                {currentFailedAttempts}
              </span>
            }
          />
          <Figure label="Post" value={`${summary.postCompletedAttempts || 0}/${summary.postAttempts || 0}`} />
        </FigureStrip>
      </div>

      {activeJobs.length > 0 && (
        <div style={{ marginTop: 'var(--space-6)' }}>
          <div
            style={{
              display: 'flex',
              alignItems: 'baseline',
              justifyContent: 'space-between',
              flexWrap: 'wrap',
              gap: 'var(--space-3)',
            }}
          >
            <h3>Active workers</h3>
            <span
              style={{
                display: 'flex',
                gap: 'var(--space-4)',
                color: 'var(--text-3)',
                fontSize: 'var(--text-xs)',
              }}
            >
              <span>{activeJobs.length} active</span>
              {longestActiveJobMs > 0 && <span>longest {formatActiveJobElapsed(longestActiveJobMs)}</span>}
            </span>
          </div>
          <div
            aria-label="Active workers by workflow depth"
            className="chip-row"
            style={{ margin: 'var(--space-4) 0 var(--space-3)' }}
          >
            {activeDepths.map((stage) => {
              const description =
                stage.depth == null
                  ? `${stage.label}: ${stage.count} active worker${stage.count === 1 ? '' : 's'}`
                  : `Depth ${stage.depth}: ${stage.count} active worker${stage.count === 1 ? '' : 's'}`;
              return (
                <span key={stage.key} className="chip" title={description} aria-label={description}>
                  {stage.label}
                  <span style={{ color: 'var(--text-3)' }}>{stage.count}</span>
                </span>
              );
            })}
          </div>
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Worker</th>
                  <th>Stage</th>
                  <th>Model</th>
                  <th className="cell-num">Elapsed</th>
                </tr>
              </thead>
              <tbody>
                {activeJobs.map((job) => (
                  <ActiveJobCard key={job.id} job={job} />
                ))}
              </tbody>
            </table>
          </div>
          <div style={{ marginTop: 'var(--space-2)', color: 'var(--text-3)', fontSize: 'var(--text-xs)' }}>
            Live duration is informational. The engine reports failures separately below.
          </div>
        </div>
      )}

      {recentEmptyResults.length > 0 && (
        <div style={{ marginTop: 'var(--space-6)' }}>
          <div className="field-label" style={{ marginBottom: 'var(--space-2)' }}>
            Completed with no results
          </div>
          <div>
            {recentEmptyResults.slice(0, 3).map((result) => (
              <div key={result.id} style={{ padding: 'var(--space-3) 0', borderTop: '1px solid var(--border-2)' }}>
                <div
                  style={{
                    display: 'flex',
                    flexWrap: 'wrap',
                    gap: 'var(--space-3)',
                    marginBottom: 'var(--space-1)',
                    color: 'var(--text-2)',
                    fontSize: 'var(--text-xs)',
                  }}
                >
                  <span className="mono">{result.source}</span>
                  <span>{result.title}</span>
                </div>
                <div style={{ color: 'var(--text-2)', fontSize: 'var(--text-sm)', lineHeight: 1.5 }}>
                  {result.explanation}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {recentErrors.length > 0 && (
        <div style={{ marginTop: 'var(--space-6)' }}>
          {recentErrors.slice(0, 5).map((err) => {
            const expanded = expandedErrorIds.has(err.id);
            const previousRun = Boolean(err.previousRun);
            const timestamp = scanErrorTimestamp(err);
            return (
              <div key={err.id} style={{ padding: 'var(--space-4) 0', borderTop: '1px solid var(--border-2)' }}>
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'baseline',
                    flexWrap: 'wrap',
                    gap: 'var(--space-3)',
                    marginBottom: 'var(--space-2)',
                  }}
                >
                  <span
                    style={{
                      minWidth: 0,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                      color: previousRun ? 'var(--text-3)' : 'var(--fail)',
                      fontSize: 'var(--text-sm)',
                    }}
                  >
                    {previousRun ? 'Previous run, ' : ''}
                    <span className="mono">{err.source}</span> {err.title}
                  </span>
                  <span
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 'var(--space-4)',
                      flexWrap: 'wrap',
                      justifyContent: 'flex-end',
                      flex: 'none',
                    }}
                  >
                    {timestamp && (
                      <time
                        dateTime={timestamp.dateTime}
                        title={`Error occurred ${timestamp.label}`}
                        style={{ color: 'var(--text-3)', fontSize: 'var(--text-xs)', whiteSpace: 'nowrap' }}
                      >
                        {timestamp.label}
                      </time>
                    )}
                    <span style={{ color: 'var(--text-3)', fontSize: 'var(--text-xs)' }}>{err.phaseLabel}</span>
                    <button
                      type="button"
                      className="btn btn--quiet btn--sm"
                      aria-expanded={expanded}
                      onClick={() => toggleError(err.id)}
                    >
                      {expanded ? 'Hide' : 'Show'}
                    </button>
                  </span>
                </div>
                {!previousRun && err.knownError && <KnownErrorBadge knownError={err.knownError} />}
                <ExpandableErrorMessage message={err.message} expanded={expanded} />
                {!previousRun && <ErrorFixLinks knownError={err.knownError} />}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

// Post-script chips: any result key prefixed "_chip_" becomes a chip. The label is
// the key without the prefix; the value is shown below it. Capped at MAX_CHIPS.
const CHIP_PREFIX = '_chip_';
const MAX_CHIPS = 3;

export function FindingActorTypeCell({ maliciousActor, vulnerabilityType }) {
  const actor = typeof maliciousActor === 'string' && maliciousActor.trim() ? maliciousActor.trim() : '—';
  const type = typeof vulnerabilityType === 'string' && vulnerabilityType.trim() ? vulnerabilityType.trim() : 'finding';

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'flex-start',
        gap: 'var(--space-2)',
        minWidth: 0,
      }}
    >
      <span
        aria-label={`Malicious actor: ${actor}`}
        title={`Malicious actor: ${actor}`}
        style={{
          display: 'block',
          maxWidth: '100%',
          fontSize: 'var(--text-sm)',
          color: 'var(--text)',
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        }}
      >
        {actor}
      </span>
      <span className="chip" title={type} style={{ maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis' }}>
        {type}
      </span>
    </div>
  );
}

function chipValue(value) {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

// Pull "_chip_*" keys from the primary post-script answer + every enrichment result.
function extractChips(vuln) {
  const sources = [];
  if (vuln.postScriptAnswer && typeof vuln.postScriptAnswer === 'object') sources.push(vuln.postScriptAnswer);
  for (const e of vuln.enrichments || []) if (e?.result && typeof e.result === 'object') sources.push(e.result);

  const chips = [];
  const seen = new Set();
  for (const result of sources) {
    for (const [key, value] of Object.entries(result)) {
      if (!key.startsWith(CHIP_PREFIX)) continue;
      const label = key.slice(CHIP_PREFIX.length);
      if (!label || seen.has(label)) continue;
      seen.add(label);
      chips.push({ label, value: chipValue(value) });
    }
  }
  return chips;
}

function ChipList({ chips, fallback }) {
  if (!chips.length && !fallback)
    return <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-3)' }}>None</span>;
  const shown = chips.length ? chips.slice(0, MAX_CHIPS) : [fallback];
  const extra = chips.length ? chips.length - shown.length : 0;
  const hiddenLabels = chips
    .slice(MAX_CHIPS)
    .map((c) => c.label)
    .join(', ');
  return (
    <div className="chip-row" style={{ minWidth: 0 }}>
      {shown.map((c, i) => (
        <span key={i} className="chip" title={`${c.label}: ${c.value}`} style={{ maxWidth: 180, minWidth: 0 }}>
          <span style={{ color: 'var(--text-3)' }}>{c.label.replaceAll('_', ' ')}</span>
          <span className="mono" style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {c.value}
          </span>
        </span>
      ))}
      {extra > 0 && (
        <span className="chip" title={`${extra} more: ${hiddenLabels}`}>
          +{extra}
        </span>
      )}
    </div>
  );
}

function ExpandableErrorMessage({ message, expanded }) {
  return (
    <div
      style={{
        fontSize: 'var(--text-sm)',
        color: 'var(--text-2)',
        lineHeight: 1.5,
        whiteSpace: 'pre-wrap',
        overflowWrap: 'anywhere',
        ...(expanded
          ? { maxHeight: 240, overflowY: 'auto', paddingRight: 'var(--space-1)' }
          : {
              display: '-webkit-box',
              WebkitLineClamp: 3,
              WebkitBoxOrient: 'vertical',
              overflow: 'hidden',
            }),
      }}
    >
      <LinkifiedText text={message} />
    </div>
  );
}

function KnownErrorBadge({ knownError }) {
  if (!knownError?.title) return null;
  return (
    <div style={{ marginBottom: 'var(--space-2)' }}>
      <span className="chip" style={{ borderColor: 'var(--fail)', color: 'var(--fail)', whiteSpace: 'normal' }}>
        {knownError.title}
      </span>
    </div>
  );
}

function ErrorFixLinks({ knownError }) {
  const links = knownError?.fixLinks || [];
  if (!links.length) return null;
  return (
    <div
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        gap: 'var(--space-4)',
        marginTop: 'var(--space-2)',
      }}
    >
      {links.map((link) =>
        link.internal || link.url?.startsWith('/') ? (
          <Link
            key={`${link.label}-${link.url}`}
            to={link.url}
            style={{
              color: 'var(--accent-strong)',
              textDecoration: 'underline',
              textUnderlineOffset: 2,
              fontSize: 'var(--text-xs)',
            }}
          >
            {link.label || link.url}
          </Link>
        ) : (
          <a
            key={`${link.label}-${link.url}`}
            href={link.url}
            target="_blank"
            rel="noreferrer"
            style={{
              color: 'var(--accent-strong)',
              textDecoration: 'underline',
              textUnderlineOffset: 2,
              fontSize: 'var(--text-xs)',
            }}
          >
            {link.label || link.url}
          </a>
        )
      )}
    </div>
  );
}

function ConfiguredPostScripts({ postScripts }) {
  const postScriptPages = usePagination(postScripts, { pageSize: 10 });

  return (
    <section>
      <div className="section-head">
        <h2>Configured post-scripts</h2>
      </div>
      <div className="chip-row" style={{ marginTop: 'var(--space-4)' }}>
        {postScriptPages.pageItems.map((postScript) => (
          <span key={postScript.id || postScript.name} className="chip">
            {postScript.name}
            {postScript.primary ? ' (primary)' : ''}
          </span>
        ))}
      </div>
      <Pagination {...postScriptPages} itemLabel="post-scripts" compact />
    </section>
  );
}

function ConfiguredAgentSkills({ agentSkills }) {
  const skillPages = usePagination(agentSkills, { pageSize: 10 });

  return (
    <section>
      <div className="section-head">
        <h2>Agent skills</h2>
      </div>
      <div className="chip-row" style={{ marginTop: 'var(--space-4)' }}>
        {skillPages.pageItems.map((skill) =>
          skill.sourceUrl ? (
            <a
              key={skill.id || skill.name}
              href={skill.sourceUrl}
              target="_blank"
              rel="noreferrer"
              className="chip"
              style={{ color: 'var(--accent-strong)', textDecoration: 'none' }}
            >
              {skill.name}
            </a>
          ) : (
            <span key={skill.id || skill.name} className="chip">
              {skill.name}
            </span>
          )
        )}
      </div>
      <Pagination {...skillPages} itemLabel="skills" compact />
    </section>
  );
}

function formatExtraValue(value) {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

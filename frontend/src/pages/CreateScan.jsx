import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api, ApiError } from '../api/client.js';
import { usePageChrome } from '../context/ui.jsx';
import { Spinner, ErrorState, Button } from '../components/ui.jsx';
import { Page, PageHeader } from '../components/app.jsx';
import Markdown from '../components/Markdown.jsx';
import SearchSelect from '../components/SearchSelect.jsx';
import WorkflowModelConfiguration, {
  workflowModelConfigurationForCatalog,
  workflowModelConfigurationIsValid,
} from '../components/WorkflowModelConfiguration.jsx';
import { configuredModelCatalog, configuredModelProviders, modelCatalogIsReady } from '../lib/modelProviders.js';
import { modelOverridesEqual, reconcileModelOverrides, workflowDepths } from '../lib/modelOverrides.js';
import { combineSeverityRanker } from '../lib/severityRanker.js';
import { defaultRankerIds, defaultWorkflowId } from '../lib/scanPresentation.js';
import { scanConfigurationDraft } from '../lib/scanDuplication.js';
import { extraInputText, hasExtraValue, requiredScanExtraKeys } from '../lib/scanExtras.js';
import { filterAgentSkills } from '../lib/agentSkillSearch.js';
import { configuredMaxFiles, localRepoFilePreflight } from '../lib/localRepoFiles.js';
import { useUnsavedChangesPrompt } from '../lib/useUnsavedChangesPrompt.js';
import { useModalDialog } from '../lib/useModalDialog.js';
import { useNewestFirst, usePagination } from '../lib/usePagination.js';
import Pagination from '../components/Pagination.jsx';

const MODEL_CATALOG_RETRY_LIMIT = 25;
const MODEL_CATALOG_RETRY_DELAY_MS = 1_000;

const GITHUB_REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?$/;

function normalizeGithubRepo(input) {
  const raw = (input ?? '').toString().trim();
  if (!raw) return '';
  if (GITHUB_REPO_RE.test(raw)) return raw.replace(/\.git$/, '');
  const ssh = /^git@github\.com:([^/]+)\/([^/#?]+?)(?:\.git)?$/.exec(raw);
  if (ssh) return `${ssh[1]}/${ssh[2]}`;
  try {
    const withProtocol = raw.startsWith('github.com/') ? `https://${raw}` : raw;
    const u = new URL(withProtocol);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return raw;
    if (u.hostname !== 'github.com') return raw;
    const segs = u.pathname.split('/').filter(Boolean);
    if (segs.length < 2) return raw;
    return `${segs[0]}/${segs[1].replace(/\.git$/, '')}`;
  } catch {
    return raw;
  }
}

function isValidRemoteRepo(input) {
  return GITHUB_REPO_RE.test(normalizeGithubRepo(input));
}

function formatRemoteRepoInput(input) {
  return isValidRemoteRepo(input) ? normalizeGithubRepo(input) : input;
}

const blankDependency = () => ({ kind: 'remote', repo_full: '', commit_sha: '' });

export function scanLaunchChoiceRequired(error) {
  return (
    error instanceof ApiError && error.status === 409 && error.errors?.some((item) => item?.field === 'launchPolicy')
  );
}

export default function CreateScan() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const duplicateFromId = params.get('from')?.trim() || '';
  const isDuplicating = Boolean(duplicateFromId);
  usePageChrome(
    [
      { label: 'Scans', to: '/scans' },
      { label: isDuplicating ? 'Duplicate configuration' : 'New scan', active: true },
    ],
    null,
    []
  );

  const [refData, setRefData] = useState(null);
  const [duplicateSource, setDuplicateSource] = useState(null);
  const [loadErr, setLoadErr] = useState(null);
  const [modelCatalogError, setModelCatalogError] = useState(null);
  const [modelCatalogRetryCount, setModelCatalogRetryCount] = useState(0);
  const [rankerPreviewOpen, setRankerPreviewOpen] = useState(false);
  const [agentSkillQuery, setAgentSkillQuery] = useState('');
  const [form, setForm] = useState({
    workflowId: '',
    postScriptId: '',
    postScriptIds: [],
    agentSkillIds: [],
    repoKind: 'remote',
    repoUrl: '',
    repoLocal: '',
    commit_sha: '',
    repo_scope: 'full repository',
    dependencies: [], // [{ kind, repo_full, commit_sha }]
    configuration: '{\n  "max_files": 4000,\n  "include_tests": false\n}',
    model: '',
    model_provider: '',
    harness: '',
    thinking_effort: 'medium',
    post_processing_model_override: false,
    post_processing_model: '',
    post_processing_model_provider: '',
    post_processing_harness: '',
    post_processing_thinking_effort: 'medium',
    model_overrides: {},
    extra: {},
    rankerIds: [],
    rankerExtra: '', // severity ranker: ordered ranker ids + per-scan custom rules
    jobLimit: '',
  });
  const [saving, setSaving] = useState(false);
  const [pendingScan, setPendingScan] = useState(null);
  const [serverErrors, setServerErrors] = useState([]);
  const [dirty, setDirty] = useState(false);
  const [localRepoFileStats, setLocalRepoFileStats] = useState({
    repoName: '',
    status: 'idle',
    fileCount: null,
    complete: true,
    snapshotIssues: [],
    error: null,
  });
  const [localRepoFileStatsRetry, setLocalRepoFileStatsRetry] = useState(0);
  const { allow } = useUnsavedChangesPrompt(dirty || saving);

  useEffect(() => {
    const repoName = form.repoKind === 'local' ? form.repoLocal : '';
    if (!repoName) {
      setLocalRepoFileStats({
        repoName: '',
        status: 'idle',
        fileCount: null,
        complete: true,
        snapshotIssues: [],
        error: null,
      });
      return undefined;
    }

    let active = true;
    const controller = new AbortController();
    setLocalRepoFileStats({
      repoName,
      status: 'loading',
      fileCount: null,
      complete: true,
      snapshotIssues: [],
      error: null,
    });
    api
      .localRepoStats(repoName, { signal: controller.signal })
      .then((payload) => {
        if (!active) return;
        if (
          !Number.isSafeInteger(payload?.fileCount) ||
          payload.fileCount < 0 ||
          typeof payload.complete !== 'boolean' ||
          !Array.isArray(payload.snapshotIssues) ||
          payload.snapshotIssues.some((issue) => !['invalid_symlink', 'special_file'].includes(issue))
        ) {
          throw new Error('The local repository file count response was invalid.');
        }
        setLocalRepoFileStats({
          repoName,
          status: 'ready',
          fileCount: payload.fileCount,
          complete: payload.complete,
          snapshotIssues: [...new Set(payload.snapshotIssues)],
          error: null,
        });
      })
      .catch((error) => {
        if (!active || error?.name === 'AbortError') return;
        setLocalRepoFileStats({
          repoName,
          status: 'error',
          fileCount: null,
          complete: true,
          snapshotIssues: [],
          error,
        });
      });

    return () => {
      active = false;
      controller.abort();
    };
  }, [form.repoKind, form.repoLocal, localRepoFileStatsRetry]);

  useEffect(() => {
    const duplicateSourceRequest = duplicateFromId
      ? /^\d+$/.test(duplicateFromId)
        ? api.scan(duplicateFromId)
        : Promise.reject(new Error('The source scan id is invalid.'))
      : Promise.resolve(null);
    Promise.all([
      api.workflows(),
      api.postScripts(),
      api.agentSkills(),
      api.severityRankers(),
      api.localRepos(),
      api.modelProviders(),
      api.modelCatalog().then(
        (catalog) => ({ catalog, error: null }),
        (error) => ({ catalog: null, error })
      ),
      duplicateSourceRequest,
    ])
      .then(
        ([
          workflows,
          postScripts,
          agentSkills,
          severityRankers,
          localRepos,
          modelProviders,
          catalogResult,
          sourceScan,
        ]) => {
          const configuredProviders = configuredModelProviders(modelProviders);
          const modelCatalog = configuredModelCatalog(catalogResult.catalog);
          setModelCatalogError(catalogResult.error);
          setModelCatalogRetryCount(0);
          setDuplicateSource(sourceScan);
          setRefData({
            workflows,
            postScripts,
            agentSkills,
            severityRankers,
            localRepos: localRepos || [],
            modelProviders: configuredProviders,
            modelCatalog,
          });
          setForm((f) => {
            if (sourceScan) {
              const duplicateDraft = scanConfigurationDraft(sourceScan);
              const duplicateWorkflow = workflows.find((workflow) => workflow.id === duplicateDraft.workflowId);
              return {
                ...f,
                ...duplicateDraft,
                model_overrides: reconcileModelOverrides(
                  duplicateDraft.model_overrides,
                  workflowDepths(duplicateWorkflow),
                  duplicateDraft
                ),
              };
            }
            const modelConfiguration = workflowModelConfigurationForCatalog(f, configuredProviders, modelCatalog);
            return {
              ...f,
              workflowId: defaultWorkflowId(workflows, params.get('workflow') || ''),
              postScriptId: postScripts[0]?.id || '',
              postScriptIds: postScripts[0]?.id ? [postScripts[0].id] : [],
              ...modelConfiguration,
              rankerIds: defaultRankerIds(severityRankers, f.rankerIds),
            };
          });
          if (sourceScan) setDirty(true);
        }
      )
      .catch(setLoadErr);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const activeModelCatalog = refData?.modelCatalog;
  const modelReferencesLoaded = refData !== null;

  useEffect(() => {
    if (!refData || modelCatalogRetryCount >= MODEL_CATALOG_RETRY_LIMIT) return undefined;

    const needsCatalogRetry = refData.modelProviders.some(
      (provider) => !modelCatalogIsReady(refData.modelCatalog, provider)
    );
    if (!needsCatalogRetry) return undefined;

    const timer = setTimeout(() => {
      api
        .modelCatalog()
        .then((catalog) => {
          setRefData((current) => (current ? { ...current, modelCatalog: configuredModelCatalog(catalog) } : current));
          setModelCatalogError(null);
        })
        .catch(setModelCatalogError)
        .finally(() => setModelCatalogRetryCount((count) => count + 1));
    }, MODEL_CATALOG_RETRY_DELAY_MS);

    return () => clearTimeout(timer);
  }, [modelCatalogRetryCount, refData]);

  useEffect(() => {
    if (!modelReferencesLoaded) return undefined;
    let active = true;
    const refresh = () =>
      Promise.all([api.modelProviders(), api.modelCatalog()])
        .then(([providerPayload, catalogPayload]) => {
          if (!active) return;
          const modelProviders = configuredModelProviders(providerPayload);
          const modelCatalog = configuredModelCatalog(catalogPayload);
          setRefData((current) => (current ? { ...current, modelProviders, modelCatalog } : current));
          setModelCatalogError(null);
          if (!isDuplicating) {
            setForm((current) => ({
              ...current,
              ...workflowModelConfigurationForCatalog(current, modelProviders, modelCatalog),
            }));
          }
        })
        .catch((error) => active && setModelCatalogError(error));
    const timer = setInterval(refresh, 5000);
    window.addEventListener('focus', refresh);
    return () => {
      active = false;
      clearInterval(timer);
      window.removeEventListener('focus', refresh);
    };
  }, [isDuplicating, modelReferencesLoaded]);

  useEffect(() => {
    if (!activeModelCatalog || isDuplicating) return;

    setForm((f) => {
      const normalized = workflowModelConfigurationForCatalog(f, refData?.modelProviders || [], activeModelCatalog);
      if (
        normalized.model === f.model &&
        normalized.model_provider === f.model_provider &&
        normalized.thinking_effort === f.thinking_effort &&
        normalized.post_processing_model_override === f.post_processing_model_override &&
        normalized.post_processing_model === f.post_processing_model &&
        normalized.post_processing_model_provider === f.post_processing_model_provider &&
        normalized.post_processing_harness === f.post_processing_harness &&
        normalized.post_processing_thinking_effort === f.post_processing_thinking_effort &&
        normalized.harness === f.harness &&
        modelOverridesEqual(normalized.model_overrides, f.model_overrides)
      )
        return f;
      return { ...f, ...normalized };
    });
  }, [activeModelCatalog, isDuplicating, refData?.modelProviders]);

  const workflowOptions = useNewestFirst(refData?.workflows);
  const agentSkills = useNewestFirst(refData?.agentSkills);
  const filteredAgentSkills = useMemo(
    () => filterAgentSkills(agentSkills, agentSkillQuery),
    [agentSkillQuery, agentSkills]
  );
  const normalizedAgentSkillQuery = agentSkillQuery.trim().toLowerCase();
  const postScripts = useNewestFirst(refData?.postScripts);
  const severityRankers = useNewestFirst(refData?.severityRankers);
  const agentSkillPages = usePagination(filteredAgentSkills, { pageSize: 8, resetKey: normalizedAgentSkillQuery });
  const postScriptPages = usePagination(postScripts, { pageSize: 8 });
  const rankerPages = usePagination(severityRankers, { pageSize: 8 });

  const pageTitle = isDuplicating ? 'Duplicate scan configuration' : 'New scan';

  if (loadErr)
    return (
      <Page>
        <PageHeader title={pageTitle} />
        <ErrorState error={loadErr} />
      </Page>
    );
  if (!refData)
    return (
      <Page>
        <PageHeader title={pageTitle} />
        <Spinner />
      </Page>
    );

  const set = (patch) => {
    setDirty(true);
    setForm((f) => ({ ...f, ...patch }));
  };
  const setExtra = (key, value) => {
    setDirty(true);
    setForm((f) => ({ ...f, extra: { ...f.extra, [key]: value } }));
  };
  const setWorkflow = (workflowId) => {
    const workflow = refData.workflows.find((candidate) => candidate.id === workflowId);
    setDirty(true);
    setForm((current) => ({
      ...current,
      workflowId,
      model_overrides: reconcileModelOverrides(current.model_overrides, workflowDepths(workflow), current),
    }));
  };

  // local repos as SearchSelect items (id = folder name)
  const localItems = refData.localRepos.map((r) => ({ id: r.name, ...r }));
  const localMeta = (r) => {
    if (!r) return '';
    const gitRef = r.isGit ? [r.branch || 'detached', r.commit].filter(Boolean).join(' ') : '';
    return gitRef ? `${gitRef}, folder snapshot` : 'folder snapshot';
  };

  const selectedWorkflow = refData.workflows.find((w) => w.id === form.workflowId);
  const selectedWorkflowDepths = workflowDepths(selectedWorkflow);
  const selectedPostScriptIds = form.postScriptIds?.length
    ? form.postScriptIds
    : form.postScriptId
      ? [form.postScriptId]
      : [];
  const expectedExtra = requiredScanExtraKeys(selectedWorkflow, refData.postScripts, selectedPostScriptIds);
  const modelProviders = refData.modelProviders;
  const hasConfiguredProvider = modelProviders.length > 0;
  const modelConfigurationValid = workflowModelConfigurationIsValid(
    form,
    selectedWorkflowDepths,
    modelProviders,
    refData.modelCatalog
  );
  const missingExtra = expectedExtra.filter((k) => !hasExtraValue(form.extra[k]));

  // Severity ranker: concatenate selected rankers' content (in selection order)
  // followed by the per-scan custom rules → the final severity_ranker string.
  const rankerContentById = (rid) => refData.severityRankers.find((r) => r.id === rid)?.content || '';
  const combinedRanker = combineSeverityRanker(form.rankerIds.map(rankerContentById), form.rankerExtra);
  const toggleScanRanker = (rid) => {
    setDirty(true);
    setForm((f) => ({
      ...f,
      rankerIds: f.rankerIds.includes(rid) ? f.rankerIds.filter((x) => x !== rid) : [...f.rankerIds, rid],
    }));
  };

  const repoUrlValid = isValidRemoteRepo(form.repoUrl.trim());
  const targetValid = form.repoKind === 'remote' ? repoUrlValid : !!form.repoLocal;

  const dependencyEmpty = (dep) => {
    if ((dep.kind || 'remote') === 'local') return !dep.repo_full;
    return !`${dep.repo_full || ''}`.trim() && !`${dep.commit_sha || ''}`.trim();
  };
  const dependencyValid = (dep) => {
    if (dependencyEmpty(dep)) return true;
    return (dep.kind || 'remote') === 'remote' ? isValidRemoteRepo(dep.repo_full) : !!dep.repo_full;
  };
  const dependenciesValid = form.dependencies.every(dependencyValid);
  const parsedJobLimit = Number(form.jobLimit);
  const jobLimitValid =
    !form.jobLimit.trim() || (/^\d+$/.test(form.jobLimit.trim()) && parsedJobLimit >= 1 && parsedJobLimit <= 1_000_000);
  const normalizedDependencies = () =>
    form.dependencies
      .filter((dep) => !dependencyEmpty(dep))
      .map((dep) =>
        (dep.kind || 'remote') === 'remote'
          ? {
              kind: 'remote',
              repo_full: normalizeGithubRepo(dep.repo_full),
              commit_sha: `${dep.commit_sha || ''}`.trim() || 'HEAD',
            }
          : { kind: 'local', repo_full: dep.repo_full, commit_sha: null }
      );

  const canCreate =
    hasConfiguredProvider &&
    modelConfigurationValid &&
    !!form.workflowId &&
    selectedPostScriptIds.length > 0 &&
    targetValid &&
    dependenciesValid &&
    jobLimitValid &&
    missingExtra.length === 0 &&
    !!combinedRanker.trim() &&
    !saving;

  const addDep = () => {
    setDirty(true);
    setForm((f) => ({ ...f, dependencies: [...f.dependencies, blankDependency()] }));
  };
  const updateDep = (idx, patch) => {
    setDirty(true);
    setForm((f) => ({
      ...f,
      dependencies: f.dependencies.map((dep, i) => (i === idx ? { ...dep, ...patch } : dep)),
    }));
  };
  const removeDep = (idx) => {
    setDirty(true);
    setForm((f) => ({ ...f, dependencies: f.dependencies.filter((_, i) => i !== idx) }));
  };
  const addDepOnEnter = (e, dep) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (!dependencyEmpty(dep) && dependencyValid(dep)) addDep();
    }
  };

  const submitScan = async (payload) => {
    setSaving(true);
    setServerErrors([]);
    try {
      await api.createScan(payload);
      allow();
      navigate('/scans');
    } catch (e) {
      if (scanLaunchChoiceRequired(e) && !payload.launchPolicy) {
        setPendingScan(payload);
      } else if (e instanceof ApiError) {
        setServerErrors(e.errors?.map((x) => `${x.field}: ${x.message}`) || [e.message]);
      } else {
        setServerErrors([e.message]);
      }
      setSaving(false);
    }
  };

  const create = () => {
    if (!canCreate) return;
    let configuration = form.configuration;
    if (typeof form.configuration === 'string') {
      try {
        configuration = form.configuration.trim() ? JSON.parse(form.configuration) : {};
      } catch {
        configuration = form.configuration;
      }
    }
    if (configuration && typeof configuration === 'object' && !Array.isArray(configuration)) {
      configuration = { ...configuration, post_script_ids: selectedPostScriptIds, agent_skill_ids: form.agentSkillIds };
    }
    const payload = {
      workflowId: form.workflowId,
      postScriptId: selectedPostScriptIds[0],
      agentSkillIds: form.agentSkillIds,
      repo_kind: form.repoKind,
      repo_full: form.repoKind === 'remote' ? normalizeGithubRepo(form.repoUrl) : form.repoLocal,
      commit_sha: form.repoKind === 'remote' ? form.commit_sha.trim() || 'HEAD' : undefined,
      repo_scope: form.repo_scope,
      dependencies: normalizedDependencies(),
      configuration,
      model: form.model,
      model_provider: form.model_provider,
      harness: form.harness,
      thinking_effort: form.thinking_effort,
      ...(form.post_processing_model_override
        ? {
            post_processing_model: form.post_processing_model,
            post_processing_model_provider: form.post_processing_model_provider,
            post_processing_harness: form.post_processing_harness,
          }
        : {}),
      post_processing_thinking_effort: form.post_processing_thinking_effort,
      model_overrides: form.model_overrides,
      severity_ranker: combinedRanker,
      extra: form.extra,
      jobLimit: form.jobLimit.trim() ? Number(form.jobLimit) : null,
    };
    submitScan(payload);
  };

  const chooseLaunchPolicy = (launchPolicy) => {
    if (!pendingScan || saving) return;
    const payload = { ...pendingScan, launchPolicy };
    setPendingScan(null);
    submitScan(payload);
  };

  const blockedLabel = !hasConfiguredProvider
    ? 'Add a provider in Accounts'
    : !modelConfigurationValid
      ? 'Complete the model configuration'
      : !form.workflowId
        ? 'Select a workflow'
        : selectedPostScriptIds.length === 0
          ? 'Select a post-script'
          : !targetValid
            ? form.repoKind === 'remote'
              ? 'Enter a valid repo'
              : 'Select a local repository'
            : !dependenciesValid
              ? 'Fix dependency rows'
              : !jobLimitValid
                ? 'Fix maximum model jobs'
                : missingExtra.length
                  ? `Fill ${missingExtra.length} required extra`
                  : !combinedRanker.trim()
                    ? 'Add severity ranking rules'
                    : 'Create scan';

  const togglePostScript = (id) => {
    setDirty(true);
    setForm((f) => {
      const current = f.postScriptIds?.length ? f.postScriptIds : f.postScriptId ? [f.postScriptId] : [];
      const next = current.includes(id) ? current.filter((x) => x !== id) : [...current, id];
      return { ...f, postScriptIds: next, postScriptId: next[0] || '' };
    });
  };
  const toggleAgentSkill = (id) => {
    setDirty(true);
    setForm((f) => {
      const current = f.agentSkillIds || [];
      const next = current.includes(id) ? current.filter((x) => x !== id) : [...current, id];
      return { ...f, agentSkillIds: next };
    });
  };

  return (
    <Page style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, paddingBottom: 0 }}>
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', paddingBottom: 'var(--space-8)' }}>
        <PageHeader
          title={pageTitle}
          meta={
            isDuplicating
              ? 'Review the copied configuration, make any changes, then create a new scan.'
              : 'Point a workflow at a repository. The engine queues it and runs every step.'
          }
          actions={
            <button
              type="button"
              className="btn btn--primary create-scan-submit"
              onClick={create}
              disabled={!canCreate}
            >
              {saving ? 'Creating…' : canCreate ? 'Create scan' : blockedLabel}
            </button>
          }
        />

        {duplicateSource && (
          <div
            role="note"
            style={{
              marginBottom: 'var(--space-7)',
              padding: 'var(--space-4) var(--space-5)',
              border: '1px solid var(--border)',
              borderRadius: 'var(--radius-sm)',
              background: 'var(--surface-2)',
              color: 'var(--text-2)',
              fontSize: 'var(--text-sm)',
              lineHeight: 'var(--leading-base)',
            }}
          >
            Configuration copied from{' '}
            <Link to={`/scans/${duplicateSource.id}`} style={{ color: 'var(--accent-strong)' }}>
              {duplicateSource.repoDisplay || duplicateSource.repoFull || `scan ${duplicateSource.id}`}
            </Link>
            . Results, logs, status, attempts, and timestamps are not copied.
          </div>
        )}

        <Section title="Workflow">
          <div style={{ maxWidth: 520 }}>
            <SearchSelect
              items={workflowOptions}
              value={form.workflowId}
              onChange={setWorkflow}
              height={32}
              placeholder="Search workflows…"
              renderTrigger={(w) => (
                <span style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-4)', minWidth: 0 }}>
                  <span
                    style={{
                      fontWeight: 500,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {w?.name || 'Select workflow'}
                  </span>
                  {w && <span style={{ color: 'var(--text-3)', fontSize: 'var(--text-xs)' }}>{w.stepCount} steps</span>}
                </span>
              )}
              renderItem={(w) => (
                <div style={{ minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: 'var(--space-4)' }}>
                    <span style={{ fontWeight: 500, fontSize: 'var(--text-sm)' }}>{w.name}</span>
                    <span style={{ color: 'var(--text-3)', fontSize: 'var(--text-xs)' }}>{w.stepCount} steps</span>
                  </div>
                  <div style={{ color: 'var(--text-2)', fontSize: 'var(--text-xs)', marginTop: 'var(--space-1)' }}>
                    {w.description}
                  </div>
                </div>
              )}
              filter={(w, q) => w.name.toLowerCase().includes(q) || (w.description || '').toLowerCase().includes(q)}
            />
          </div>
        </Section>

        <Section title="Target">
          <Pills
            value={form.repoKind}
            onChange={(k) => set({ repoKind: k })}
            options={[
              ['remote', 'Remote'],
              ['local', 'Local'],
            ]}
          />

          {form.repoKind === 'remote' ? (
            <div
              className="create-scan-two-column"
              style={{
                display: 'grid',
                gridTemplateColumns: 'minmax(0, 2fr) minmax(0, 1fr)',
                gap: 'var(--space-6)',
              }}
            >
              <Field label="Repository">
                <Input
                  value={form.repoUrl}
                  onChange={(e) => set({ repoUrl: e.target.value })}
                  onBlur={() => set({ repoUrl: formatRemoteRepoInput(form.repoUrl) })}
                  placeholder="https://github.com/org/repo"
                  mono
                  aria-invalid={form.repoUrl && !repoUrlValid ? 'true' : undefined}
                />
                {form.repoUrl && !repoUrlValid && <FieldError>Use owner/repo or a GitHub URL.</FieldError>}
              </Field>
              <Field label="Commit SHA">
                <Input
                  value={form.commit_sha}
                  onChange={(e) => set({ commit_sha: e.target.value })}
                  placeholder="HEAD"
                  mono
                />
              </Field>
            </div>
          ) : (
            <div style={{ display: 'grid', gap: 'var(--space-4)' }}>
              <Field label="Local repository">
                <SearchSelect
                  height={32}
                  items={localItems}
                  value={form.repoLocal}
                  onChange={(name) => set({ repoLocal: name })}
                  placeholder="Search local repos…"
                  emptyText="No local repos found under the configured root."
                  renderTrigger={(r) => (
                    <span style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-4)', minWidth: 0 }}>
                      <span
                        style={{
                          color: r ? 'var(--text)' : 'var(--text-3)',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {r?.name || 'Select a local repository'}
                      </span>
                      {r && (
                        <span style={{ color: 'var(--text-3)', fontSize: 'var(--text-xs)', whiteSpace: 'nowrap' }}>
                          {localMeta(r)}
                        </span>
                      )}
                    </span>
                  )}
                  renderItem={(r) => (
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontWeight: 500, fontSize: 'var(--text-sm)' }}>{r.name}</div>
                      <div
                        className="mono"
                        style={{
                          color: 'var(--text-3)',
                          fontSize: 'var(--text-2xs)',
                          marginTop: 'var(--space-1)',
                        }}
                      >
                        {r.path}, {localMeta(r) || 'not a git repo'}
                      </div>
                    </div>
                  )}
                  filter={(r, q) => r.name.toLowerCase().includes(q)}
                />
              </Field>
              <LocalRepoFilePreflight
                stats={localRepoFileStats}
                repoName={form.repoLocal}
                configuration={form.configuration}
                onRetry={() => setLocalRepoFileStatsRetry((attempt) => attempt + 1)}
              />
              <p className="field-note">
                At scan start, open·kritt takes one snapshot of this folder, including modified and untracked files but
                excluding .git. Git is not required. The selected model provider receives the snapshot contents; create
                a new scan to capture later changes.
              </p>
            </div>
          )}

          <div style={{ maxWidth: 360 }}>
            <Field label="Repository scope">
              <Input value={form.repo_scope} onChange={(e) => set({ repo_scope: e.target.value })} />
            </Field>
          </div>
        </Section>

        <Section title="Dependencies" note="Optional, scanned alongside the target.">
          <div style={{ display: 'grid', gap: 'var(--space-5)' }}>
            {form.dependencies.map((dep, i) => (
              <div
                key={i}
                style={{
                  display: 'grid',
                  gap: 'var(--space-5)',
                  paddingTop: i === 0 ? 0 : 'var(--space-5)',
                  borderTop: i === 0 ? 0 : '1px solid var(--border-2)',
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 'var(--space-4)',
                  }}
                >
                  <Pills
                    value={dep.kind || 'remote'}
                    onChange={(kind) => updateDep(i, { kind, repo_full: '', commit_sha: '' })}
                    options={[
                      ['remote', 'Remote'],
                      ['local', 'Local'],
                    ]}
                  />
                  <button
                    type="button"
                    onClick={() => removeDep(i)}
                    aria-label={`Remove dependency ${i + 1}`}
                    className="btn btn--quiet btn--sm"
                  >
                    Remove
                  </button>
                </div>
                {(dep.kind || 'remote') === 'remote' ? (
                  <div
                    className="create-scan-two-column"
                    style={{
                      display: 'grid',
                      gridTemplateColumns: 'minmax(0, 2fr) minmax(0, 1fr)',
                      gap: 'var(--space-6)',
                    }}
                  >
                    <Field label="Dependency repository">
                      <Input
                        value={dep.repo_full || ''}
                        onChange={(e) => updateDep(i, { repo_full: e.target.value })}
                        onBlur={() => updateDep(i, { repo_full: formatRemoteRepoInput(dep.repo_full) })}
                        onKeyDown={(e) => addDepOnEnter(e, dep)}
                        placeholder="org/lib"
                        mono
                        aria-invalid={dep.repo_full && !isValidRemoteRepo(dep.repo_full) ? 'true' : undefined}
                      />
                      {dep.repo_full && !isValidRemoteRepo(dep.repo_full) && (
                        <FieldError>Use owner/repo or a GitHub URL.</FieldError>
                      )}
                    </Field>
                    <Field label="Commit SHA">
                      <Input
                        value={dep.commit_sha || ''}
                        onChange={(e) => updateDep(i, { commit_sha: e.target.value })}
                        onKeyDown={(e) => addDepOnEnter(e, dep)}
                        placeholder="HEAD"
                        mono
                      />
                    </Field>
                  </div>
                ) : (
                  <div style={{ display: 'grid', gap: 'var(--space-3)' }}>
                    <Field label="Local repository">
                      <SearchSelect
                        height={32}
                        items={localItems}
                        value={dep.repo_full || ''}
                        onChange={(name) => updateDep(i, { repo_full: name, commit_sha: null })}
                        placeholder="Search local repos…"
                        emptyText="No local repos found."
                        renderTrigger={(r) => (
                          <span style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-4)', minWidth: 0 }}>
                            <span
                              style={{
                                color: r ? 'var(--text)' : 'var(--text-3)',
                                overflow: 'hidden',
                                textOverflow: 'ellipsis',
                                whiteSpace: 'nowrap',
                              }}
                            >
                              {r?.name || 'Select a local repository'}
                            </span>
                            {r && (
                              <span
                                style={{ color: 'var(--text-3)', fontSize: 'var(--text-xs)', whiteSpace: 'nowrap' }}
                              >
                                {localMeta(r)}
                              </span>
                            )}
                          </span>
                        )}
                        renderItem={(r) => (
                          <div style={{ minWidth: 0 }}>
                            <div style={{ fontWeight: 500, fontSize: 'var(--text-sm)' }}>{r.name}</div>
                            <div
                              className="mono"
                              style={{
                                color: 'var(--text-3)',
                                fontSize: 'var(--text-2xs)',
                                marginTop: 'var(--space-1)',
                              }}
                            >
                              {r.path}, {localMeta(r)}
                            </div>
                          </div>
                        )}
                        filter={(r, q) => r.name.toLowerCase().includes(q)}
                      />
                    </Field>
                    <p className="field-note">
                      Snapshotted once with the target when the scan starts. A new scan captures later changes.
                    </p>
                  </div>
                )}
              </div>
            ))}
            {form.dependencies.length === 0 && <p className="field-note">No dependencies added.</p>}
            <div>
              <button type="button" className="btn" onClick={addDep}>
                + Add dependency
              </button>
            </div>
          </div>
        </Section>

        <Section title="Configuration">
          <textarea
            value={form.configuration}
            onChange={(e) => set({ configuration: e.target.value })}
            spellCheck={false}
            className="textarea mono"
            style={{ minHeight: 96, background: 'var(--code-bg)' }}
          />
          <div style={{ maxWidth: 300 }}>
            <Field label="Maximum model jobs" unit="Optional">
              <Input
                value={form.jobLimit}
                onChange={(e) => set({ jobLimit: e.target.value })}
                type="number"
                min="1"
                max="1000000"
                step="1"
                placeholder="unlimited"
                mono
                aria-invalid={jobLimitValid ? undefined : 'true'}
              />
              <p className="field-note">
                Exact cap across workflow and post-processing jobs. Internal retries do not consume extra jobs.
              </p>
              {!jobLimitValid && <FieldError>Enter a whole number from 1 to 1,000,000.</FieldError>}
            </Field>
          </div>
        </Section>

        <Section title="Extra">
          {expectedExtra.length > 0 ? (
            <div style={{ display: 'grid', gap: 'var(--space-6)' }}>
              <p className="field-note">
                The selected workflow and post-scripts reference <span className="mono">{'{{extra.…}}'}</span> keys.
                Provide a value for each.
              </p>
              {expectedExtra.map((k) => (
                <Field key={k} label={<span className="mono">{`extra.${k}`}</span>}>
                  <textarea
                    value={extraInputText(form.extra[k])}
                    onChange={(e) => setExtra(k, e.target.value)}
                    placeholder="required"
                    spellCheck={false}
                    className="textarea mono"
                    style={{
                      minHeight: 160,
                      background: 'var(--code-bg)',
                      borderColor: hasExtraValue(form.extra[k]) ? 'var(--border)' : 'var(--fail)',
                    }}
                    aria-invalid={hasExtraValue(form.extra[k]) ? undefined : 'true'}
                  />
                </Field>
              ))}
            </div>
          ) : (
            <p className="field-note">
              {selectedWorkflow ? (
                <>
                  The selected workflow and post-scripts don’t reference any{' '}
                  <span className="mono">{'{{extra.…}}'}</span> keys, so there is nothing to fill in here.
                </>
              ) : (
                'Select a workflow to see its extra keys.'
              )}
            </p>
          )}
        </Section>

        <Section title="Model and harness">
          <WorkflowModelConfiguration
            value={form}
            onChange={(configuration) => {
              setDirty(true);
              setForm((current) => ({ ...current, ...configuration }));
            }}
            providers={modelProviders}
            catalog={refData.modelCatalog}
            catalogError={modelCatalogError}
            depths={selectedWorkflowDepths}
            depthChips={selectedWorkflow?.depthChips || []}
          />
        </Section>

        <Section title="Agent skills" note="Optional.">
          {agentSkills.length > 0 && (
            <AgentSkillSearchInput
              value={agentSkillQuery}
              onChange={setAgentSkillQuery}
              listId="create-scan-agent-skills"
            />
          )}
          <div
            id="create-scan-agent-skills"
            role="group"
            aria-label="Agent skills"
            style={{ borderTop: '1px solid var(--border-2)', overflowY: 'auto', maxHeight: 360 }}
          >
            {agentSkillPages.pageItems.map((skill) => {
              const active = form.agentSkillIds.includes(skill.id);
              return (
                <div
                  key={skill.id}
                  style={{
                    display: 'flex',
                    alignItems: 'flex-start',
                    borderBottom: '1px solid var(--border-2)',
                    background: active ? 'var(--accent-subtle)' : 'transparent',
                  }}
                >
                  <button
                    type="button"
                    onClick={() => toggleAgentSkill(skill.id)}
                    aria-pressed={active}
                    style={{
                      display: 'flex',
                      alignItems: 'flex-start',
                      gap: 'var(--space-4)',
                      padding: 'var(--space-4) var(--space-5)',
                      flex: 1,
                      minWidth: 0,
                      textAlign: 'left',
                      color: 'inherit',
                    }}
                  >
                    <span
                      aria-hidden="true"
                      className="mono"
                      style={{
                        width: 16,
                        height: 16,
                        flex: 'none',
                        marginTop: 1,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        border: `1px solid ${active ? 'var(--accent)' : 'var(--border)'}`,
                        borderRadius: 'var(--radius-xs)',
                        background: active ? 'var(--accent)' : 'var(--surface)',
                        color: 'var(--accent-fg)',
                        fontSize: 'var(--text-2xs)',
                      }}
                    >
                      {active ? '✓' : ''}
                    </span>
                    <span style={{ minWidth: 0, flex: 1 }}>
                      <span style={{ display: 'block', fontWeight: 500, fontSize: 'var(--text-sm)' }}>
                        {skill.name}
                      </span>
                      <span
                        style={{
                          display: 'block',
                          color: 'var(--text-2)',
                          fontSize: 'var(--text-xs)',
                          marginTop: 'var(--space-1)',
                        }}
                      >
                        {skill.description}
                      </span>
                      <span
                        className="mono"
                        style={{
                          display: 'flex',
                          gap: 'var(--space-4)',
                          color: 'var(--text-3)',
                          fontSize: 'var(--text-2xs)',
                          marginTop: 'var(--space-1)',
                          overflow: 'hidden',
                          whiteSpace: 'nowrap',
                          textOverflow: 'ellipsis',
                        }}
                      >
                        {[skill.slug, skill.licenseSpdx].filter(Boolean).map((value) => (
                          <span key={value}>{value}</span>
                        ))}
                      </span>
                    </span>
                  </button>
                  {skill.sourceUrl && (
                    <a
                      href={skill.sourceUrl}
                      target="_blank"
                      rel="noreferrer"
                      style={{
                        flex: 'none',
                        margin: 'var(--space-4) var(--space-5) 0 0',
                        color: 'var(--accent-strong)',
                        fontSize: 'var(--text-xs)',
                        textDecoration: 'underline',
                        textUnderlineOffset: 2,
                      }}
                    >
                      Source
                    </a>
                  )}
                </div>
              );
            })}
            {agentSkills.length === 0 && (
              <div style={{ color: 'var(--text-3)', fontSize: 'var(--text-sm)', padding: 'var(--space-5)' }}>
                No agent skills defined.
              </div>
            )}
            {agentSkills.length > 0 && filteredAgentSkills.length === 0 && (
              <div
                role="status"
                aria-live="polite"
                style={{ color: 'var(--text-3)', fontSize: 'var(--text-sm)', padding: 'var(--space-5)' }}
              >
                No agent skills match “{agentSkillQuery.trim()}”.
              </div>
            )}
          </div>
          <Pagination {...agentSkillPages} itemLabel="skills" compact />
          <p className="field-note">
            {form.agentSkillIds.length} selected.
            {agentSkillQuery.trim() ? ` ${filteredAgentSkills.length} of ${agentSkills.length} skills match.` : ''}{' '}
            Selected skills are installed into each executor agent for this scan.
          </p>
        </Section>

        <Section title="Post-scripts">
          <div style={{ borderTop: '1px solid var(--border-2)', overflowY: 'auto', maxHeight: 360 }}>
            {postScriptPages.pageItems.map((p) => {
              const active = selectedPostScriptIds.includes(p.id);
              return (
                <button
                  type="button"
                  key={p.id}
                  onClick={() => togglePostScript(p.id)}
                  aria-pressed={active}
                  style={{
                    display: 'flex',
                    alignItems: 'flex-start',
                    gap: 'var(--space-4)',
                    width: '100%',
                    padding: 'var(--space-4) var(--space-5)',
                    borderBottom: '1px solid var(--border-2)',
                    background: active ? 'var(--accent-subtle)' : 'transparent',
                    color: 'inherit',
                    textAlign: 'left',
                  }}
                >
                  <span
                    aria-hidden="true"
                    className="mono"
                    style={{
                      width: 16,
                      height: 16,
                      flex: 'none',
                      marginTop: 1,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      border: `1px solid ${active ? 'var(--accent)' : 'var(--border)'}`,
                      borderRadius: 'var(--radius-xs)',
                      background: active ? 'var(--accent)' : 'var(--surface)',
                      color: 'var(--accent-fg)',
                      fontSize: 'var(--text-2xs)',
                    }}
                  >
                    {active ? '✓' : ''}
                  </span>
                  <span style={{ minWidth: 0, flex: 1 }}>
                    <span style={{ display: 'block', fontWeight: 500, fontSize: 'var(--text-sm)' }}>{p.name}</span>
                    <span
                      style={{
                        display: 'block',
                        color: 'var(--text-2)',
                        fontSize: 'var(--text-xs)',
                        marginTop: 'var(--space-1)',
                      }}
                    >
                      {p.description}
                    </span>
                    {(p.keys || []).length > 0 && (
                      <span
                        className="mono"
                        style={{
                          display: 'block',
                          color: 'var(--text-3)',
                          fontSize: 'var(--text-2xs)',
                          marginTop: 'var(--space-1)',
                          overflow: 'hidden',
                          whiteSpace: 'nowrap',
                          textOverflow: 'ellipsis',
                        }}
                      >
                        {p.keys.join(', ')}
                      </span>
                    )}
                  </span>
                </button>
              );
            })}
          </div>
          <Pagination {...postScriptPages} itemLabel="post-scripts" compact />
          <p className="field-note">
            {selectedPostScriptIds.length} selected. The first selected script is stored as the scan primary; all
            selected scripts run after ranking.
          </p>
        </Section>

        <Section
          title="Severity ranker"
          note="Pick any number of rankers. Their rules are concatenated, then your scan-specific rules are appended."
        >
          <div
            className="create-scan-ranker-grid"
            style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 'var(--space-4)' }}
          >
            {rankerPages.pageItems.map((r) => {
              const on = form.rankerIds.includes(r.id);
              const order = on ? form.rankerIds.indexOf(r.id) + 1 : '';
              return (
                <button
                  type="button"
                  key={r.id}
                  onClick={() => toggleScanRanker(r.id)}
                  aria-pressed={on}
                  style={{
                    display: 'flex',
                    alignItems: 'flex-start',
                    gap: 'var(--space-4)',
                    width: '100%',
                    padding: 'var(--space-4) var(--space-5)',
                    border: `1px solid ${on ? 'var(--accent)' : 'var(--border)'}`,
                    borderRadius: 'var(--radius-sm)',
                    background: on ? 'var(--accent-subtle)' : 'transparent',
                    color: 'inherit',
                    textAlign: 'left',
                  }}
                >
                  <span
                    className="mono"
                    style={{
                      width: 18,
                      flex: 'none',
                      marginTop: 1,
                      color: on ? 'var(--accent-strong)' : 'var(--text-3)',
                      fontSize: 'var(--text-xs)',
                      fontWeight: 600,
                    }}
                  >
                    {order}
                  </span>
                  <span style={{ minWidth: 0 }}>
                    <span style={{ display: 'block', fontWeight: 500, fontSize: 'var(--text-sm)' }}>
                      {r.name}
                      {r.isDefault ? (
                        <span
                          style={{
                            color: 'var(--accent-strong)',
                            fontSize: 'var(--text-2xs)',
                            marginLeft: 'var(--space-3)',
                          }}
                        >
                          default
                        </span>
                      ) : null}
                    </span>
                    <span
                      style={{
                        display: 'block',
                        color: 'var(--text-2)',
                        fontSize: 'var(--text-xs)',
                        marginTop: 'var(--space-1)',
                        lineHeight: 'var(--leading-base)',
                      }}
                    >
                      {r.description}
                    </span>
                  </span>
                </button>
              );
            })}
            {refData.severityRankers.length === 0 && (
              <p className="field-note">
                No saved rankers, add scan-specific rules below, or create one under Severity rankers.
              </p>
            )}
          </div>
          <Pagination {...rankerPages} itemLabel="rankers" compact />

          <Field label="Scan-specific rules" unit="Optional, Markdown">
            <textarea
              value={form.rankerExtra}
              onChange={(e) => set({ rankerExtra: e.target.value })}
              spellCheck={false}
              placeholder="e.g. Treat anything reachable from the public checkout flow as at least High."
              className="textarea mono"
              style={{ minHeight: 84, background: 'var(--code-bg)' }}
            />
          </Field>

          <div>
            <button
              type="button"
              onClick={() => setRankerPreviewOpen((o) => !o)}
              aria-expanded={rankerPreviewOpen}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 'var(--space-5)',
                width: '100%',
                padding: 'var(--space-4) 0',
                borderTop: '1px solid var(--border-2)',
                borderBottom: '1px solid var(--border-2)',
                textAlign: 'left',
                whiteSpace: 'nowrap',
              }}
            >
              <span
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 'var(--space-3)',
                  fontSize: 'var(--text-sm)',
                  whiteSpace: 'nowrap',
                }}
              >
                Combined ruleset
                <span className="mono" style={{ color: 'var(--text-3)', fontSize: 'var(--text-2xs)' }}>
                  severity_ranker
                </span>
              </span>
              <span className="mono" style={{ color: 'var(--text-3)', fontSize: 'var(--text-2xs)' }}>
                {form.rankerIds.length} ranker{form.rankerIds.length === 1 ? '' : 's'}
                {form.rankerExtra.trim() ? ', custom rules' : ''}
                {combinedRanker.length ? `, ${combinedRanker.length} chars` : ', empty'}
              </span>
            </button>
            {rankerPreviewOpen && (
              <div
                style={{
                  borderBottom: '1px solid var(--border-2)',
                  background: 'var(--surface-2)',
                  padding: 'var(--space-5)',
                  maxHeight: 300,
                  overflowY: 'auto',
                }}
              >
                {combinedRanker.trim() ? (
                  <Markdown source={combinedRanker} />
                ) : (
                  <p className="field-note">No rules selected yet. Add a ranker or scan-specific rules.</p>
                )}
              </div>
            )}
          </div>
        </Section>

        {serverErrors.length > 0 && (
          <div role="alert" style={{ marginTop: 'var(--space-7)', display: 'grid', gap: 'var(--space-1)' }}>
            {serverErrors.map((message, index) => (
              <div key={`${message}-${index}`} className="field-error">
                {message}
              </div>
            ))}
          </div>
        )}
      </div>

      {pendingScan && (
        <ScanLaunchDialog saving={saving} onClose={() => setPendingScan(null)} onChoose={chooseLaunchPolicy} />
      )}

      <div
        style={{
          flex: 'none',
          borderTop: '1px solid var(--border)',
          background: 'var(--bg)',
          padding: 'var(--space-5) 0',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'flex-end',
        }}
      >
        <button type="button" className="btn btn--primary create-scan-submit" onClick={create} disabled={!canCreate}>
          {saving ? 'Creating…' : canCreate ? 'Create scan' : blockedLabel}
        </button>
      </div>
    </Page>
  );
}

// ---- small building blocks ----
export function AgentSkillSearchInput({ value, onChange, listId }) {
  return (
    <div style={{ position: 'relative' }}>
      <Input
        type="text"
        role="searchbox"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== 'Escape') return;
          event.preventDefault();
          onChange('');
        }}
        aria-label="Search agent skills"
        aria-controls={listId}
        autoComplete="off"
        maxLength={200}
        placeholder="Search by name, slug, description, or license…"
        mono
        style={{ paddingRight: value ? 36 : undefined }}
      />
      {value && (
        <button
          type="button"
          onClick={() => onChange('')}
          aria-label="Clear agent skill search"
          title="Clear search"
          style={{
            position: 'absolute',
            top: '50%',
            right: 'var(--space-3)',
            transform: 'translateY(-50%)',
            width: 24,
            height: 24,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            borderRadius: 'var(--radius-xs)',
            color: 'var(--text-3)',
            fontSize: 'var(--text-md)',
            lineHeight: 1,
          }}
        >
          ×
        </button>
      )}
    </div>
  );
}

export function LocalRepoFilePreflight({ stats, repoName, configuration, onRetry }) {
  const visibleStats = repoName && stats?.repoName !== repoName ? { status: 'loading' } : stats;
  if (!visibleStats || visibleStats.status === 'idle') return null;

  const panelStyle = {
    display: 'grid',
    gap: 'var(--space-2)',
    padding: 'var(--space-4) var(--space-5)',
    border: '1px solid var(--border)',
    borderRadius: 'var(--radius-sm)',
    background: 'var(--surface-2)',
    fontSize: 'var(--text-xs)',
    lineHeight: 'var(--leading-base)',
  };

  if (visibleStats.status === 'loading') {
    return (
      <div role="status" aria-live="polite" style={{ ...panelStyle, color: 'var(--text-2)' }}>
        Counting snapshot files…
      </div>
    );
  }

  if (visibleStats.status === 'error') {
    return (
      <div role="status" aria-live="polite" style={{ ...panelStyle, borderColor: 'var(--pend)' }}>
        <div style={{ color: 'var(--text-2)' }}>
          Couldn’t count files. You can still create the scan, but the preflight check is unavailable.
        </div>
        <div>
          <button
            type="button"
            onClick={onRetry}
            className="btn btn--quiet btn--sm"
            style={{ color: 'var(--accent-strong)' }}
          >
            Retry count
          </button>
        </div>
      </div>
    );
  }

  const preflight = localRepoFilePreflight(visibleStats.fileCount, configuredMaxFiles(configuration), {
    complete: visibleStats.complete,
  });
  if (!preflight) return null;

  const overLimit = preflight.kind === 'over_limit';
  const atLimit = preflight.kind === 'at_limit';
  const invalidSymlink = visibleStats.snapshotIssues?.includes('invalid_symlink');
  const specialFile = visibleStats.snapshotIssues?.includes('special_file');
  const snapshotIncompatible = invalidSymlink || specialFile;
  const progress =
    preflight.maxFiles && (preflight.complete || preflight.isOverLimit)
      ? Math.min(100, Math.max(0, (preflight.fileCount / preflight.maxFiles) * 100))
      : null;
  const tone = overLimit || snapshotIncompatible ? 'var(--fail)' : atLimit ? 'var(--pend)' : 'var(--accent)';

  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        ...panelStyle,
        borderColor: overLimit || snapshotIncompatible ? 'var(--fail)' : 'var(--border)',
        background: overLimit || snapshotIncompatible ? 'var(--fail-bg)' : 'var(--surface-2)',
      }}
    >
      <div
        className="mono"
        style={{ color: overLimit || snapshotIncompatible ? 'var(--fail)' : 'var(--text)', fontWeight: 600 }}
      >
        {preflight.summary}
      </div>
      {progress !== null && (
        <div
          data-file-count-progress
          aria-hidden="true"
          style={{
            height: 4,
            borderRadius: 'var(--radius-pill)',
            background: 'var(--border)',
            overflow: 'hidden',
          }}
        >
          <div
            style={{ width: `${progress}%`, height: '100%', borderRadius: 'var(--radius-pill)', background: tone }}
          />
        </div>
      )}
      {snapshotIncompatible && (
        <div style={{ color: 'var(--fail)', fontWeight: 600 }}>
          This folder contains{' '}
          {invalidSymlink && specialFile
            ? 'absolute or out-of-root symlinks and unsupported special files'
            : invalidSymlink
              ? 'one or more absolute or out-of-root symlinks'
              : 'one or more unsupported special files'}
          . The engine cannot safely snapshot it, so the scan is expected to fail unless the incompatible entries are
          removed.
        </div>
      )}
      <div style={{ color: 'var(--text-2)' }}>{preflight.detail}</div>
      <div style={{ color: 'var(--text-3)', fontSize: 'var(--text-2xs)' }}>
        This count reflects the folder now; the fixed scan snapshot is taken when the scan starts.
      </div>
    </div>
  );
}

export function ScanLaunchDialog({ saving = false, onClose, onChoose }) {
  const dialogRef = useModalDialog(onClose);

  return (
    <div role="presentation" className="dialog-wrap" onMouseDown={() => !saving && onClose()}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="scan-launch-title"
        tabIndex={-1}
        onMouseDown={(event) => event.stopPropagation()}
        className="dialog"
        style={{ width: 500, maxWidth: '100%' }}
      >
        <div className="dialog-head">
          <h2 id="scan-launch-title" className="dialog-title">
            A scan is already running
          </h2>
        </div>
        <div className="dialog-body">
          <p style={{ color: 'var(--text-2)', fontSize: 'var(--text-sm)', lineHeight: 'var(--leading-prose)' }}>
            Start this scan in the concurrent pool, or place it behind immediate scans until capacity is available.
          </p>
        </div>
        <div className="dialog-foot">
          <Button variant="ghost" disabled={saving} onClick={() => onChoose('queue')}>
            Queue
          </Button>
          <Button data-autofocus disabled={saving} onClick={() => onChoose('immediate')}>
            {saving ? 'Creating…' : 'Start immediately'}
          </Button>
        </div>
      </div>
    </div>
  );
}

function Section({ title, note, children }) {
  return (
    <section style={{ marginTop: 'var(--space-9)' }}>
      <div className="section-head">
        <div>
          <h2>{title}</h2>
          {note && <p className="panel-note">{note}</p>}
        </div>
      </div>
      <div style={{ display: 'grid', gap: 'var(--space-6)', paddingTop: 'var(--space-5)' }}>{children}</div>
    </section>
  );
}

function Field({ label, unit, children }) {
  return (
    <div className="field">
      <div className="field-label">
        <span>{label}</span>
        {unit && <span className="field-unit">{unit}</span>}
      </div>
      {children}
    </div>
  );
}

function FieldError({ children }) {
  return <div className="field-error">{children}</div>;
}

function Input({ mono, style, ...props }) {
  return <input {...props} spellCheck={false} className={mono ? 'input mono' : 'input'} style={style} />;
}

function Pills({ value, onChange, options }) {
  return (
    <div className="filters" style={{ width: 'fit-content', justifySelf: 'start' }}>
      {options.map(([val, label]) => {
        const active = value === val;
        return (
          <button
            type="button"
            key={val}
            onClick={() => onChange(val)}
            aria-pressed={active}
            className={active ? 'filter is-active' : 'filter'}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}

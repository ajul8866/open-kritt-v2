import { useEffect, useMemo, useRef, useState } from 'react';
import { Button } from './ui.jsx';
import { useModalDialog } from '../lib/useModalDialog.js';
import {
  GITHUB_DESTINATION,
  SHARE_CARD_HEIGHT,
  SHARE_CARD_WIDTH,
  SHARE_IMAGE_FILENAME,
  buildCommunityShareArtifact,
  buildShareArtifact,
  canvasToPngBlob,
  copyShareText,
  downloadShareBlob,
  renderShareCard,
  shareWithChannel,
} from '../lib/shareResult.js';

function shareFile(blob) {
  if (!blob || typeof File === 'undefined') return null;
  return new File([blob], SHARE_IMAGE_FILENAME, { type: 'image/png' });
}

export default function ShareResultDialog({ severity = null, mode = 'result', onClose }) {
  const communityMode = mode === 'community';
  const [includeSeverity, setIncludeSeverity] = useState(false);
  const [imageBlob, setImageBlob] = useState(null);
  const [imageError, setImageError] = useState(null);
  const [busyAction, setBusyAction] = useState(null);
  const [feedback, setFeedback] = useState(null);
  const canvasRef = useRef(null);

  const closeDialog = () => onClose();
  const dialogRef = useModalDialog(closeDialog);
  const cardArtifact = useMemo(
    () => (communityMode ? buildCommunityShareArtifact() : buildShareArtifact({ includeSeverity, severity })),
    [communityMode, includeSeverity, severity]
  );
  const xArtifact = useMemo(
    () =>
      communityMode
        ? buildCommunityShareArtifact({ channel: 'x' })
        : buildShareArtifact({ includeSeverity, severity, channel: 'x' }),
    [communityMode, includeSeverity, severity]
  );
  const elsewhereArtifact = useMemo(
    () =>
      communityMode
        ? buildCommunityShareArtifact({ channel: 'elsewhere' })
        : buildShareArtifact({ includeSeverity, severity, channel: 'elsewhere' }),
    [communityMode, includeSeverity, severity]
  );

  useEffect(() => {
    let active = true;
    setImageBlob(null);
    setImageError(null);
    setFeedback(null);
    Promise.resolve()
      .then(() => renderShareCard(canvasRef.current, cardArtifact))
      .then(() => canvasToPngBlob(canvasRef.current))
      .then((blob) => {
        if (active) setImageBlob(blob);
      })
      .catch((error) => {
        if (active) setImageError(error);
      });
    return () => {
      active = false;
    };
  }, [cardArtifact]);

  const runAction = async (name, action) => {
    if (!imageBlob || busyAction) return;
    setBusyAction(name);
    setFeedback(null);
    try {
      await action();
    } catch (error) {
      if (error?.name !== 'AbortError') {
        setFeedback({ tone: 'error', message: error?.message || 'Sharing failed. Please try again.' });
      }
    } finally {
      setBusyAction(null);
    }
  };

  const shareOnX = () =>
    runAction('x', async () => {
      const result = await shareWithChannel({
        artifact: xArtifact,
        file: shareFile(imageBlob),
        blob: imageBlob,
      });
      setFeedback(
        result.kind === 'x-fallback'
          ? {
              tone: 'success',
              message: 'The PNG was downloaded. Attach it to the prefilled X post that just opened.',
            }
          : { tone: 'success', message: 'The X-ready image and @Kritt_AI caption were sent to your share sheet.' }
      );
    });

  const shareElsewhere = () =>
    runAction('elsewhere', async () => {
      const result = await shareWithChannel({
        artifact: elsewhereArtifact,
        file: shareFile(imageBlob),
        blob: imageBlob,
      });
      if (result.kind === 'unsupported') {
        await copyShareText(elsewhereArtifact.caption);
        setFeedback({
          tone: 'success',
          message: 'Native sharing is unavailable, so the GitHub-linked post was copied instead.',
        });
      } else if (result.kind === 'text-shared') {
        setFeedback({
          tone: 'success',
          message: 'The GitHub-linked post was sent to your share sheet. You can download the PNG separately.',
        });
      } else {
        setFeedback({ tone: 'success', message: 'The image and GitHub-linked post were sent to your share sheet.' });
      }
    });

  const copyPost = () =>
    runAction('copy', async () => {
      await copyShareText(elsewhereArtifact.caption);
      setFeedback({ tone: 'success', message: 'Post copied with the open·kritt GitHub link.' });
    });

  const downloadImage = () =>
    runAction('download', async () => {
      downloadShareBlob(imageBlob);
      setFeedback({ tone: 'success', message: 'PNG downloaded.' });
    });

  const imageReady = Boolean(imageBlob) && !imageError;

  return (
    <div
      className="scrim"
      role="presentation"
      onMouseDown={closeDialog}
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 'var(--space-6)',
      }}
    >
      <div
        ref={dialogRef}
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="share-result-title"
        tabIndex={-1}
        onMouseDown={(event) => event.stopPropagation()}
        style={{ width: 'min(760px, 100%)', padding: 0 }}
      >
        <div className="dialog-head">
          <div>
            <h2 id="share-result-title" className="dialog-title">
              {communityMode ? 'Support the open-source community.' : 'It’s open source. Give back to the community.'}
            </h2>
            <p
              style={{
                maxWidth: '62ch',
                marginTop: 'var(--space-3)',
                color: 'var(--text-2)',
                fontSize: 'var(--text-sm)',
                lineHeight: 'var(--leading-base)',
              }}
            >
              {communityMode
                ? 'Share open·kritt with other researchers or star it on GitHub. Both help more people discover, use, and improve the project.'
                : 'Share what open·kritt helped you accomplish, never the classified vulnerability details.'}
            </p>
          </div>
          <button type="button" className="btn btn--icon btn--sm" aria-label="Close share dialog" onClick={closeDialog}>
            ×
          </button>
        </div>

        <div className="dialog-body" style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-5)' }}>
          {communityMode && (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 'var(--space-5)',
                padding: 'var(--space-4) var(--space-5)',
                borderRadius: 'var(--radius-sm)',
                background: 'var(--surface-2)',
                color: 'var(--text-2)',
                fontSize: 'var(--text-xs)',
                lineHeight: 'var(--leading-base)',
              }}
            >
              <span>
                <strong style={{ color: 'var(--text)', fontWeight: 500 }}>Prefer not to post?</strong> A GitHub star is
                a quick way to help open·kritt grow.
              </span>
              <a
                href={GITHUB_DESTINATION}
                target="_blank"
                rel="noreferrer"
                style={{ flex: 'none', color: 'var(--accent-strong)', fontWeight: 500 }}
              >
                Star on GitHub
              </a>
            </div>
          )}

          <canvas
            ref={canvasRef}
            width={SHARE_CARD_WIDTH}
            height={SHARE_CARD_HEIGHT}
            role="img"
            aria-label={`Share-card preview: ${cardArtifact.cardText}`}
            style={{
              display: 'block',
              width: '100%',
              height: 'auto',
              aspectRatio: '1200 / 630',
              border: '1px solid var(--border)',
              borderRadius: 'var(--radius-sm)',
              background: 'var(--surface-2)',
            }}
          />

          {!communityMode && severity && (
            <label className="checkbox-row" style={{ color: 'var(--text-2)' }}>
              <input
                className="checkbox"
                type="checkbox"
                checked={includeSeverity}
                onChange={(event) => setIncludeSeverity(event.target.checked)}
              />
              <span style={{ display: 'grid', gap: 'var(--space-1)' }}>
                <strong style={{ color: 'var(--text)', fontWeight: 500 }}>Include severity</strong>
                <small style={{ color: 'var(--text-3)', fontSize: 'var(--text-xs)' }}>
                  This reveals only the normalized severity shown in the preview.
                </small>
              </span>
            </label>
          )}

          <div
            style={{
              padding: 'var(--space-4) var(--space-5)',
              borderRadius: 'var(--radius-sm)',
              background: 'var(--surface-2)',
              color: 'var(--text-2)',
              fontSize: 'var(--text-xs)',
              lineHeight: 'var(--leading-base)',
            }}
          >
            {communityMode ? (
              <>This shares only open·kritt branding and project links. No scan or vulnerability data is included.</>
            ) : (
              <>
                No repository, finding title, path, code, report, PoC, model, scan ID, count, or timestamp is included.
                Sharing open·kritt, not the vulnerability details, is the safe way to contribute back.
              </>
            )}
          </div>

          {imageError && (
            <div
              role="alert"
              style={{
                padding: 'var(--space-3) var(--space-5)',
                borderRadius: 'var(--radius-sm)',
                background: 'var(--fail-bg)',
                color: 'var(--fail)',
                fontSize: 'var(--text-xs)',
              }}
            >
              {imageError.message}
            </div>
          )}
          {feedback && (
            <div
              role={feedback.tone === 'error' ? 'alert' : 'status'}
              aria-live="polite"
              style={{
                padding: 'var(--space-3) var(--space-5)',
                borderRadius: 'var(--radius-sm)',
                background: feedback.tone === 'error' ? 'var(--fail-bg)' : 'var(--ok-bg)',
                color: feedback.tone === 'error' ? 'var(--fail)' : 'var(--ok)',
                fontSize: 'var(--text-xs)',
              }}
            >
              {feedback.message}
            </div>
          )}
        </div>

        <div className="dialog-foot" style={{ justifyContent: 'space-between', flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-3)' }}>
            <Button data-autofocus disabled={!imageReady || Boolean(busyAction)} onClick={shareOnX}>
              {busyAction === 'x' ? 'Sharing…' : 'Share on X'}
            </Button>
            <Button variant="subtle" disabled={!imageReady || Boolean(busyAction)} onClick={shareElsewhere}>
              {busyAction === 'elsewhere' ? 'Sharing…' : 'Share elsewhere'}
            </Button>
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-3)' }}>
            <Button variant="ghost" disabled={!imageReady || Boolean(busyAction)} onClick={copyPost}>
              {busyAction === 'copy' ? 'Copying…' : 'Copy post'}
            </Button>
            <Button variant="ghost" disabled={!imageReady || Boolean(busyAction)} onClick={downloadImage}>
              {busyAction === 'download' ? 'Downloading…' : 'Download PNG'}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

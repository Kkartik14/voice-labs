import type { RunArtifact, RunProgressSnapshot } from "../domain/model.js";

export function mergeRunProgress(current: RunArtifact, progress: RunProgressSnapshot): RunArtifact {
  if (progress.id !== current.id) return current;

  const status = progress.status ?? current.status;
  const currentEvidence = current.evidence;
  const progressEvidence = progress.evidence;
  const evidenceChanged = Boolean(currentEvidence && progressEvidence && (
    currentEvidence.status !== progressEvidence.status
    || (progressEvidence.sessionId !== undefined && currentEvidence.sessionId !== progressEvidence.sessionId)
    || (progressEvidence.message !== undefined && currentEvidence.message !== progressEvidence.message)
  ));
  if (status === current.status && !evidenceChanged) return current;

  return {
    ...current,
    status,
    ...(evidenceChanged && currentEvidence && progressEvidence ? {
      evidence: {
        ...currentEvidence,
        status: progressEvidence.status,
        ...(progressEvidence.sessionId === undefined ? {} : { sessionId: progressEvidence.sessionId }),
        ...(progressEvidence.message === undefined ? {} : { message: progressEvidence.message }),
      },
    } : {}),
  };
}

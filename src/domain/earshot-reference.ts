import type { EarshotIncidentReference, RunArtifact } from "./model.js";

/** A destination is identified by its host, project, and incident. */
export function earshotIncidentReferenceKey(reference: EarshotIncidentReference): string {
  return JSON.stringify([reference.endpoint, reference.upstreamProjectId ?? null, reference.incidentId]);
}

/** Preserve each destination while merging delivery progress for that destination. */
export function mergeEarshotIncidentReference(
  references: readonly EarshotIncidentReference[],
  reference: EarshotIncidentReference,
): EarshotIncidentReference[] {
  const key = earshotIncidentReferenceKey(reference);
  const existingIndex = references.findIndex((item) => earshotIncidentReferenceKey(item) === key);
  if (existingIndex < 0) return [...references, { ...reference }];

  const existing = references[existingIndex]!;
  return references.map((item, index) => index === existingIndex
    ? {
      ...existing,
      deliveryStatus: existing.deliveryStatus === "attached" || reference.deliveryStatus === "attached"
        ? "attached"
        : "attempted",
    }
    : item);
}

export function mergeEarshotIncidentReferences(
  references: readonly EarshotIncidentReference[],
  additions: readonly (EarshotIncidentReference | undefined)[],
): EarshotIncidentReference[] {
  return additions.reduce(
    (merged, reference) => reference ? mergeEarshotIncidentReference(merged, reference) : merged,
    [...references],
  );
}

export function earshotIncidentReferenceFromRun(run: RunArtifact): EarshotIncidentReference | undefined {
  const evidence = run.evidence;
  if (!evidence?.incidentId || !evidence.endpoint) return undefined;
  return {
    incidentId: evidence.incidentId,
    endpoint: evidence.endpoint,
    deliveryStatus: evidence.status === "attached" ? "attached" : "attempted",
    ...(evidence.upstreamProjectId ? { upstreamProjectId: evidence.upstreamProjectId } : {}),
  };
}

export function sortEarshotIncidentReferences(
  references: readonly EarshotIncidentReference[],
): EarshotIncidentReference[] {
  return [...references].sort((left, right) =>
    left.incidentId.localeCompare(right.incidentId)
    || left.endpoint.localeCompare(right.endpoint)
    || (left.upstreamProjectId ?? "").localeCompare(right.upstreamProjectId ?? ""));
}

// A group joins board-local occurrences. Containers keep ownership of their children.
export function selectedGroups(groups, placementIds, decorationIds) {
  return groups.filter(group => group.placementIds.some(id => placementIds.has(id)) ||
    group.decorationIds.some(id => decorationIds.has(id)));
}

export function includeGroupMembers(groups, placementIds, decorationIds) {
  for (const group of selectedGroups(groups, placementIds, decorationIds)) {
    for (const id of group.placementIds) placementIds.add(id);
    for (const id of group.decorationIds) decorationIds.add(id);
  }
}

export function completeGroups(groups, placementIds, decorationIds) {
  return selectedGroups(groups, placementIds, decorationIds).filter(group =>
    group.placementIds.every(id => placementIds.has(id)) && group.decorationIds.every(id => decorationIds.has(id)));
}

export function sameGroups(before, after, placementIds, decorationIds) {
  const placements = new Set(placementIds), drawings = new Set(decorationIds);
  return JSON.stringify(selectedGroups(before.groups || [],placements,drawings)) ===
    JSON.stringify(selectedGroups(after.groups || [],placements,drawings));
}

export function containedOccurrences(decorations) {
  const placements = new Set(), drawings = new Set();
  for (const decoration of decorations) {
    for (const child of decoration.container?.children || []) {
      if (typeof child === "string") drawings.add(child);
      else if (child?.placementId) placements.add(child.placementId);
    }
  }
  return {placements,drawings};
}

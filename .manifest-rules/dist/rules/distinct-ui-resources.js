/**
 * Validation rule: distinct-ui-resources
 *
 * Multiple UI modules may intentionally share a `resource` and frontend entry
 * point. Forge supports this configuration, but it can also be accidental when
 * different extension points require different views.
 *
 * A UI module is any entry under `modules.<type>` that declares a `resource`
 * key; backend modules such as `function`/`trigger` have no `resource` and are
 * therefore ignored. A warning is emitted for each module that shares a
 * resource, so the agent can confirm the sharing is intentional without being
 * forced to create duplicate entry files.
 */
import { isSeq, isMap } from 'yaml';
import { getModuleKey, getPosition, getPropertyValue, getTopLevelMap, parseManifestRoot, } from '../yaml-utils.js';
export const RULE_NAME = 'distinct-ui-resources';
/**
 * Find UI modules that share a `resource`.
 *
 * @param yamlContent - The raw YAML content of the manifest file
 * @param root - Optional pre-parsed manifest root, supplied by `validateManifest`
 *   to avoid re-parsing the same document once per rule. When omitted the
 *   document is parsed from `yamlContent`.
 */
export function validateDistinctUiResources(yamlContent, root = parseManifestRoot(yamlContent)) {
    const warnings = [];
    if (!root)
        return warnings;
    const modulesNode = getTopLevelMap(root, 'modules');
    if (!modulesNode)
        return warnings;
    // Collect every UI module (one that references a resource), grouped by resource key.
    const byResource = new Map();
    for (const pair of modulesNode.items) {
        if (!pair.key || !isSeq(pair.value))
            continue;
        const moduleType = String(pair.key);
        for (const item of pair.value.items) {
            if (!isMap(item))
                continue;
            const resource = getPropertyValue(item, 'resource');
            if (typeof resource !== 'string' || resource.length === 0)
                continue;
            const uiModule = {
                node: item,
                moduleType,
                moduleKey: getModuleKey(item),
                resource,
            };
            const existing = byResource.get(resource);
            if (existing) {
                existing.push(uiModule);
            }
            else {
                byResource.set(resource, [uiModule]);
            }
        }
    }
    for (const [resource, sharers] of byResource) {
        if (sharers.length < 2)
            continue;
        for (const { node, moduleType, moduleKey } of sharers) {
            const otherSharers = sharers.filter((sharer) => sharer.node !== node);
            const otherSharerLabels = otherSharers
                .map((sharer) => `${sharer.moduleType} (key: ${sharer.moduleKey})`)
                .join(', ');
            const otherModuleLabel = otherSharers.length === 1 ? 'module' : 'modules';
            const pos = getPosition(node, yamlContent);
            warnings.push({
                rule: RULE_NAME,
                message: `Module '${moduleType}' (key: ${moduleKey}) shares resource '${resource}' with ${otherSharers.length} other UI ${otherModuleLabel}: ${otherSharerLabels}. Forge supports this configuration, and each module will execute the same frontend entry point.`,
                suggestion: `If these modules should render different views, give each module its own resource and entry file, e.g.:\n  resources:\n    - key: ${moduleKey}-resource\n      path: src/frontend/${moduleKey}.jsx\nand set 'resource: ${moduleKey}-resource' on this module. If sharing is intentional, no change is required.`,
                line: pos.line,
                column: pos.column,
                moduleType,
                moduleKey,
            });
        }
    }
    return warnings;
}

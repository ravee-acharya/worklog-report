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
import { type YAMLMap } from 'yaml';
import type { ValidationWarning } from '../types.js';
export declare const RULE_NAME = "distinct-ui-resources";
/**
 * Find UI modules that share a `resource`.
 *
 * @param yamlContent - The raw YAML content of the manifest file
 * @param root - Optional pre-parsed manifest root, supplied by `validateManifest`
 *   to avoid re-parsing the same document once per rule. When omitted the
 *   document is parsed from `yamlContent`.
 */
export declare function validateDistinctUiResources(yamlContent: string, root?: YAMLMap | null): ValidationWarning[];
//# sourceMappingURL=distinct-ui-resources.d.ts.map
/**
 * Validation rule: ui-kit-module-structure
 *
 * Ensures UI-based modules have a valid structure for either supported render
 * mode:
 * - **UI Kit**: has 'resource' AND 'render: native'.
 * - **Custom UI**: has 'resource' but NO 'render' key (the app ships its own
 *   static assets; Forge omits 'render' for Custom UI).
 *
 * Both modes require a 'resource' and must NOT use the legacy top-level
 * 'function' pattern. An explicit 'render' value other than 'native' is treated
 * as a mistake (Custom UI omits 'render' entirely rather than setting it to
 * another value).
 *
 * This rule only applies to modules in UI_KIT_MODULES list.
 */
import type { ValidationError } from '../types.js';
export declare const RULE_NAME = "ui-kit-module-structure";
/**
 * Validate that UI Kit modules have the correct structure.
 *
 * @param yamlContent - The raw YAML content of the manifest file
 * @returns Array of validation errors
 */
export declare function validateUiKitModuleStructure(yamlContent: string): ValidationError[];
//# sourceMappingURL=ui-kit-module-structure.d.ts.map
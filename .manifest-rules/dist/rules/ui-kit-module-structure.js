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
import { parseDocument, isMap, isSeq } from 'yaml';
import { isUiKitModule } from '../schema/native-render-modules.js';
import { getModuleKey, getPosition, getPropertyValue } from '../yaml-utils.js';
export const RULE_NAME = 'ui-kit-module-structure';
/**
 * Check if a property exists in a YAML map node.
 */
function hasProperty(node, propName) {
    for (const pair of node.items) {
        if (pair.key && String(pair.key) === propName) {
            return true;
        }
    }
    return false;
}
/**
 * Validate a single module for UI Kit structure requirements.
 */
function validateModule(moduleNode, moduleType, source) {
    const errors = [];
    // Only validate UI Kit modules
    if (!isUiKitModule(moduleType)) {
        return errors;
    }
    const moduleKey = getModuleKey(moduleNode);
    const nodeWithRange = moduleNode;
    const pos = getPosition(nodeWithRange, source);
    const hasResource = hasProperty(moduleNode, 'resource');
    const hasTopLevelFunction = hasProperty(moduleNode, 'function');
    const renderValue = getPropertyValue(moduleNode, 'render');
    // Check: 'configuration' is not a valid Forge manifest key — the correct key is 'config'
    // This only applies to macro modules where config is a supported property
    if (moduleType === 'macro' && hasProperty(moduleNode, 'configuration')) {
        errors.push({
            rule: RULE_NAME,
            message: `Module '${moduleKey}' (${moduleType}) uses 'configuration' which is not a valid Forge manifest property. The correct property name is 'config'.`,
            suggestion: `Replace 'configuration' with 'config: true' and use ForgeReconciler.addConfig() in your frontend entry-point file to define the configuration UI.`,
            line: pos.line,
            column: pos.column,
            moduleType,
            moduleKey,
        });
    }
    // Check 1: Must have 'resource' for UI Kit
    if (!hasResource) {
        errors.push({
            rule: RULE_NAME,
            message: `Module '${moduleKey}' (${moduleType}) is missing 'resource' property. UI Kit modules require a resource pointing to frontend code.`,
            suggestion: `Add a 'resource' property pointing to your UI Kit frontend entry point. Example:\n  ${moduleType}:\n    - key: ${moduleKey}\n      resource: main\n      render: native`,
            line: pos.line,
            column: pos.column,
            moduleType,
            moduleKey,
        });
    }
    // Check 2: render mode must be valid when a resource exists.
    // - 'render: native'      -> UI Kit (valid)
    // - no 'render' key       -> Custom UI (valid; Forge omits render for Custom UI)
    // - any other 'render'    -> mistake (Custom UI omits render rather than
    //                            setting an alternative value)
    if (hasResource && renderValue !== undefined && renderValue !== 'native') {
        errors.push({
            rule: RULE_NAME,
            message: `Module '${moduleKey}' (${moduleType}) has 'render: ${renderValue}', which is not valid. Use 'render: native' for UI Kit, or omit 'render' entirely for Custom UI.`,
            suggestion: `Set 'render: native' for UI Kit, or remove the 'render' property to use Custom UI.`,
            line: pos.line,
            column: pos.column,
            moduleType,
            moduleKey,
        });
    }
    // Check 3: Sub-entry-points with 'resource' must use a valid render mode.
    // The Forge CLI recognises these sub-entry-points on modules. When they have a
    // 'resource', UI Kit requires 'render: native' while Custom UI omits 'render';
    // any other explicit render value is a mistake.
    const SUB_ENTRY_POINTS = ['config', 'edit', 'view', 'create', 'contextConfig', 'target'];
    for (const entryPointName of SUB_ENTRY_POINTS) {
        const entryPointValue = getPropertyValue(moduleNode, entryPointName);
        if (entryPointValue && isMap(entryPointValue)) {
            const subNode = entryPointValue;
            const hasSubResource = hasProperty(subNode, 'resource');
            // Macro config should use 'config: true' with ForgeReconciler.addConfig(), not a separate config resource file
            if (entryPointName === 'config' && moduleType === 'macro' && hasSubResource) {
                errors.push({
                    rule: RULE_NAME,
                    message: `Module '${moduleKey}' (${moduleType}) uses 'config.resource' for a separate config file. Use 'config: true' with ForgeReconciler.addConfig() in your main entry-point file instead.`,
                    suggestion: `Replace:\n  config:\n    resource: ${getPropertyValue(subNode, 'resource')}\n    render: native\nWith:\n  config: true\nThen define your config component using ForgeReconciler.addConfig(<Config />) in the same file as ForgeReconciler.render(<App />).`,
                    line: pos.line,
                    column: pos.column,
                    moduleType,
                    moduleKey,
                });
                continue;
            }
            if (hasSubResource) {
                const subRenderValue = getPropertyValue(subNode, 'render');
                // Same render-mode rules as the top-level check: 'native' is UI Kit,
                // omitting 'render' is Custom UI, any other value is a mistake.
                if (subRenderValue !== undefined && subRenderValue !== 'native') {
                    errors.push({
                        rule: RULE_NAME,
                        message: `Module '${moduleKey}' (${moduleType}) has '${entryPointName}.render: ${subRenderValue}', which is not valid. Use '${entryPointName}.render: native' for UI Kit, or omit '${entryPointName}.render' for Custom UI.`,
                        suggestion: `Set '${entryPointName}.render: native' for UI Kit, or remove '${entryPointName}.render' to use Custom UI.`,
                        line: pos.line,
                        column: pos.column,
                        moduleType,
                        moduleKey,
                    });
                }
            }
        }
    }
    // Check 4: Must NOT use the legacy top-level 'function' pattern.
    // Both UI Kit and Custom UI drive their frontend from a 'resource'; backend
    // logic goes through 'resolver.function', never a top-level 'function'.
    if (hasTopLevelFunction) {
        const hasResolver = hasProperty(moduleNode, 'resolver');
        if (hasResource) {
            // Mixing a UI resource with the legacy top-level function pattern.
            errors.push({
                rule: RULE_NAME,
                message: `Module '${moduleKey}' (${moduleType}) has a top-level 'function' property, which is incompatible with a 'resource'-based module. Use 'resolver.function' for backend logic instead.`,
                suggestion: hasResolver
                    ? `Remove the top-level 'function' property. Your backend logic is already configured in 'resolver'.`
                    : `Replace the top-level 'function' with 'resolver.function' for backend calls. Example:\n  resolver:\n    function: your-function-key`,
                line: pos.line,
                column: pos.column,
                moduleType,
                moduleKey,
            });
        }
        else {
            // Top-level function but no UI resource at all - legacy pattern with no UI.
            errors.push({
                rule: RULE_NAME,
                message: `Module '${moduleKey}' (${moduleType}) uses the legacy function-based pattern with no 'resource'. UI modules need a 'resource' (UI Kit adds 'render: native'; Custom UI omits 'render').`,
                suggestion: `Add a 'resource' for the frontend and move backend logic to 'resolver.function'. Example (UI Kit):\n  ${moduleType}:\n    - key: ${moduleKey}\n      resource: main\n      render: native\n      resolver:\n        function: your-function-key`,
                line: pos.line,
                column: pos.column,
                moduleType,
                moduleKey,
            });
        }
    }
    return errors;
}
/**
 * Validate that UI Kit modules have the correct structure.
 *
 * @param yamlContent - The raw YAML content of the manifest file
 * @returns Array of validation errors
 */
export function validateUiKitModuleStructure(yamlContent) {
    const errors = [];
    let doc;
    try {
        doc = parseDocument(yamlContent, { keepSourceTokens: true });
    }
    catch (e) {
        errors.push({
            rule: RULE_NAME,
            message: `Failed to parse manifest YAML: ${e instanceof Error ? e.message : String(e)}`,
            suggestion: 'Fix the YAML syntax errors before validation can proceed.',
            line: 1,
            column: 1,
            moduleType: 'unknown',
            moduleKey: 'unknown',
        });
        return errors;
    }
    const root = doc.contents;
    if (!isMap(root)) {
        return errors;
    }
    // Find the 'modules' section
    let modulesNode = null;
    for (const pair of root.items) {
        if (pair.key && String(pair.key) === 'modules' && isMap(pair.value)) {
            modulesNode = pair.value;
            break;
        }
    }
    if (!modulesNode) {
        return errors;
    }
    // Iterate through each module type
    for (const pair of modulesNode.items) {
        if (!pair.key)
            continue;
        const moduleType = String(pair.key);
        const moduleTypeLower = moduleType.toLowerCase();
        // Check for incorrect confluence macro module keys (e.g. 'confluence:macro', 'confluence:confluenceMacro')
        // The correct top-level key for Confluence macros is just 'macro'
        if (moduleTypeLower.includes('confluence') && moduleTypeLower.includes('macro')) {
            const keyNode = pair.key;
            const pos = getPosition(keyNode, yamlContent);
            errors.push({
                rule: RULE_NAME,
                message: `Invalid module type '${moduleType}'. Confluence macros must use the top-level key 'macro', not '${moduleType}'.`,
                suggestion: `Rename '${moduleType}' to 'macro'. Example:\n  macro:\n    - key: my-macro\n      resource: main\n      render: native`,
                line: pos.line,
                column: pos.column,
                moduleType,
                moduleKey: 'unknown',
            });
            continue;
        }
        // Check for bare 'confluence' or 'confluence:' used as a module key without a valid sub-type.
        // Valid Confluence modules use prefixed keys like 'confluence:fullPage', 'confluence:contentBylineItem', etc.
        // A bare 'confluence' key is not a valid Forge module type.
        if (moduleTypeLower === 'confluence') {
            const keyNode = pair.key;
            const pos = getPosition(keyNode, yamlContent);
            errors.push({
                rule: RULE_NAME,
                message: `Invalid module type '${moduleType}'. '${moduleType}' is not a valid Forge module type. Confluence modules require a sub-type (e.g., 'confluence:fullPage', 'confluence:contentBylineItem'). For Confluence macros, use the top-level key 'macro'.`,
                suggestion: `Replace '${moduleType}' with the correct module type. For macros use:\n  macro:\n    - key: my-macro\n      resource: main\n      render: native\nFor other Confluence modules use the appropriate prefixed key, e.g. 'confluence:fullPage', 'confluence:contentBylineItem', 'confluence:spacePage'.`,
                line: pos.line,
                column: pos.column,
                moduleType,
                moduleKey: 'unknown',
            });
            continue;
        }
        // Only validate UI Kit modules
        if (!isUiKitModule(moduleType)) {
            continue;
        }
        // Each module type contains an array of module definitions
        if (!isSeq(pair.value))
            continue;
        for (const item of pair.value.items) {
            if (!isMap(item))
                continue;
            const moduleErrors = validateModule(item, moduleType, yamlContent);
            errors.push(...moduleErrors);
        }
    }
    return errors;
}

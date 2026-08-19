"use strict";
/**
 * Fake implementation of @forge/react/global.
 *
 * Provides stub components for the global:ui (Personal Apps) Forge UI
 * components so frontend code that imports from @forge/react/global can be
 * loaded and tested in a Jest/jsdom environment without the real Forge runtime.
 *
 * Components are simple React pass-through elements that render their children.
 * Non-DOM props are converted to data-* attributes for test assertions, matching
 * the behaviour of the main @forge/react shim.
 *
 * Usage:
 *   In jest.config.cjs moduleNameMapper:
 *     '^@forge/react/global$': '<rootDir>/.testing-framework/dist/shims/forge-react-global/index.js'
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.PersonalSettingsItems = exports.PersonalSettings = exports.HelpLink = exports.CreateMenuItem = exports.CreateButton = exports.FlyOutMenuItem = exports.ExpandableMenuItem = exports.LinkMenuItem = exports.Sidebar = exports.Main = exports.Global = void 0;
const react_1 = __importDefault(require("react"));
const SAFE_DOM_PROPS = new Set([
    'className',
    'id',
    'style',
    'title',
    'role',
    'tabIndex',
    'dir',
    'lang',
    'hidden',
    'accessKey',
    'draggable',
    'spellCheck',
    'translate',
    'autoFocus',
    'contentEditable',
    'name',
    'value',
    'type',
    'placeholder',
    'disabled',
    'checked',
    'readOnly',
    'required',
    'autoComplete',
    'min',
    'max',
    'step',
    'pattern',
    'maxLength',
    'minLength',
    'multiple',
    'size',
    'form',
    'formAction',
    'formMethod',
    'src',
    'alt',
    'width',
    'height',
    'href',
    'target',
    'rel',
    'colSpan',
    'rowSpan',
    'scope',
    'headers',
]);
function isSafeDomProp(key) {
    if (SAFE_DOM_PROPS.has(key))
        return true;
    if (key.startsWith('data-') || key.startsWith('aria-'))
        return true;
    if (/^on[A-Z]/.test(key))
        return true;
    return false;
}
function sanitiseProps(props) {
    const result = {};
    for (const [key, value] of Object.entries(props)) {
        if (key === 'testId') {
            result['data-testid'] = String(value);
        }
        else if (isSafeDomProp(key)) {
            result[key] = value;
        }
        else {
            if (value == null)
                continue;
            result[`data-${key.toLowerCase()}`] =
                typeof value === 'object' ? JSON.stringify(value) : String(value);
        }
    }
    return result;
}
function createStubComponent(displayName) {
    const Component = ({ children, ...rest }) => react_1.default.createElement('div', {
        'data-testid': `forge-${displayName.toLowerCase()}`,
        ...sanitiseProps(rest),
    }, children);
    Component.displayName = displayName;
    return Component;
}
// Mirrors the component surface exported by @forge/react/global
// (node_modules/@forge/react/out/components/global/index.js).
exports.Global = createStubComponent('Global');
exports.Main = createStubComponent('Main');
exports.Sidebar = createStubComponent('Sidebar');
exports.LinkMenuItem = createStubComponent('LinkMenuItem');
exports.ExpandableMenuItem = createStubComponent('ExpandableMenuItem');
exports.FlyOutMenuItem = createStubComponent('FlyOutMenuItem');
exports.CreateButton = createStubComponent('CreateButton');
exports.CreateMenuItem = createStubComponent('CreateMenuItem');
exports.HelpLink = createStubComponent('HelpLink');
exports.PersonalSettings = createStubComponent('PersonalSettings');
exports.PersonalSettingsItems = createStubComponent('PersonalSettingsItems');

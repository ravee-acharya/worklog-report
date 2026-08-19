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
import React from 'react';
type StubProps = Record<string, unknown> & {
    children?: React.ReactNode;
};
export declare const Global: React.FC<StubProps>;
export declare const Main: React.FC<StubProps>;
export declare const Sidebar: React.FC<StubProps>;
export declare const LinkMenuItem: React.FC<StubProps>;
export declare const ExpandableMenuItem: React.FC<StubProps>;
export declare const FlyOutMenuItem: React.FC<StubProps>;
export declare const CreateButton: React.FC<StubProps>;
export declare const CreateMenuItem: React.FC<StubProps>;
export declare const HelpLink: React.FC<StubProps>;
export declare const PersonalSettings: React.FC<StubProps>;
export declare const PersonalSettingsItems: React.FC<StubProps>;
export {};

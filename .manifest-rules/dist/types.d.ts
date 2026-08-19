/**
 * TypeScript types for the manifest validation package.
 */
/**
 * A validation issue with location information for agent-friendly output.
 */
export interface ValidationIssue {
    /** The rule that was violated */
    rule: string;
    /** Human-readable issue message */
    message: string;
    /** Suggested response to the issue */
    suggestion: string;
    /** 1-indexed line number where the error occurred */
    line: number;
    /** 1-indexed column number where the error occurred */
    column: number;
    /** The module type (e.g., 'jira:globalPage') */
    moduleType: string;
    /** The module key (e.g., 'my-global-page') */
    moduleKey: string;
}
/** A blocking manifest validation issue. */
export type ValidationError = ValidationIssue;
/** A non-blocking manifest validation issue. */
export type ValidationWarning = ValidationIssue;
/**
 * Result of validating a manifest file.
 */
export interface ValidationResult {
    /** Whether the manifest is valid (no errors) */
    valid: boolean;
    /** List of validation errors */
    errors: ValidationError[];
    /** List of non-blocking validation warnings */
    warnings: ValidationWarning[];
    /** Path to the manifest file that was validated */
    filePath?: string;
}
/**
 * A parsed module entry from the manifest.
 */
export interface ManifestModule {
    key: string;
    resource?: string;
    render?: 'default' | 'native';
    [key: string]: unknown;
}
//# sourceMappingURL=types.d.ts.map
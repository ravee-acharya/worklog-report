export interface TeamworkGraphValidationViolation {
    rule: string;
    message: string;
}
export interface TeamworkGraphRequestValidationInput {
    body: unknown;
    headers?: Record<string, unknown>;
    expectedQueryContext?: string;
}
export declare function validateTeamworkGraphRequestPayload(body: unknown): TeamworkGraphValidationViolation[];
export declare function validateTeamworkGraphRequest({ body, headers, expectedQueryContext, }: TeamworkGraphRequestValidationInput): TeamworkGraphValidationViolation[];

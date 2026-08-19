"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.validateTeamworkGraphRequestPayload = validateTeamworkGraphRequestPayload;
exports.validateTeamworkGraphRequest = validateTeamworkGraphRequest;
const graphql_1 = require("graphql");
const TWG_OPERATION_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9]{2,}_[A-Za-z][A-Za-z0-9]{3,}$/;
const TWG_QUERY_CONTEXT_HEADER = 'x-query-context';
const TWG_QUERY_CONTEXT_ARI_PATTERN = /^ari:cloud:[A-Za-z][A-Za-z0-9-]*:[A-Za-z0-9._~-]*:(?:site|workspace)\/[A-Za-z0-9._~:-]+$/;
function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function typeToString(node) {
    switch (node.kind) {
        case graphql_1.Kind.NAMED_TYPE:
            return node.name.value;
        case graphql_1.Kind.NON_NULL_TYPE:
            return `${typeToString(node.type)}!`;
        case graphql_1.Kind.LIST_TYPE:
            return `[${typeToString(node.type)}]`;
    }
}
function parseGraphql(query) {
    if (typeof query !== 'string') {
        return {
            violations: [
                {
                    rule: 'twg-query-must-be-string',
                    message: '`requestTeamworkGraph` query must be a GraphQL string.',
                },
            ],
        };
    }
    try {
        const document = (0, graphql_1.parse)(query);
        const fragments = new Map();
        const operations = [];
        for (const definition of document.definitions) {
            if (definition.kind === graphql_1.Kind.FRAGMENT_DEFINITION) {
                fragments.set(definition.name.value, definition);
            }
            if (definition.kind === graphql_1.Kind.OPERATION_DEFINITION) {
                operations.push(definition);
            }
        }
        return { parsed: { fragments, operations }, violations: [] };
    }
    catch (error) {
        return {
            violations: [
                {
                    rule: 'twg-graphql-parse',
                    message: `Teamwork Graph query must be valid GraphQL: ${error instanceof Error ? error.message : String(error)}`,
                },
            ],
        };
    }
}
function selectOperation(parsed, operationName) {
    const requestedOperationName = typeof operationName === 'string' && operationName.trim() ? operationName.trim() : undefined;
    if (!parsed.operations.length) {
        return {
            violations: [
                {
                    rule: 'twg-operation-required',
                    message: 'Teamwork Graph query must contain a GraphQL operation.',
                },
            ],
        };
    }
    if (requestedOperationName) {
        const operation = parsed.operations.find((candidate) => candidate.name?.value === requestedOperationName);
        if (!operation) {
            return {
                violations: [
                    {
                        rule: 'twg-operation-name-missing',
                        message: `Operation name \`${requestedOperationName}\` was passed to requestTeamworkGraph but is not present in the query.`,
                    },
                ],
            };
        }
        return { operation, violations: [] };
    }
    if (parsed.operations.length > 1) {
        return {
            violations: [
                {
                    rule: 'twg-operation-name-required',
                    message: 'Teamwork Graph queries with multiple operations must pass an operationName.',
                },
            ],
        };
    }
    return { operation: parsed.operations[0], violations: [] };
}
function validateOperationName(operation) {
    const operationName = operation.name?.value;
    if (!operationName) {
        return [
            {
                rule: 'twg-valid-operation-name',
                message: 'Teamwork Graph GraphQL operation must be named in `company_operation` format, for example `mycompany_getTeams`.',
            },
        ];
    }
    if (operationName.length > 100 || !TWG_OPERATION_NAME_PATTERN.test(operationName)) {
        return [
            {
                rule: 'twg-valid-operation-name',
                message: `Teamwork Graph operation name \`${operationName}\` must follow ` +
                    '`company_operation` format: company is at least 3 chars, operation is at least 4 chars, total length is at most 100.',
            },
        ];
    }
    return [];
}
function validateVariableDefinitions(operation) {
    const variableDefinitions = new Map((operation.variableDefinitions ?? []).map((definition) => [
        definition.variable.name.value,
        typeToString(definition.type),
    ]));
    const violations = [];
    if (variableDefinitions.get('cypherQuery') !== 'String!') {
        violations.push({
            rule: 'twg-cypher-query-variable',
            message: 'Teamwork Graph query must declare `$cypherQuery: String!` and pass it to `cypherQuery(query: $cypherQuery, ...)`.',
        });
    }
    if (variableDefinitions.get('params') !== 'CypherRequestParams') {
        violations.push({
            rule: 'twg-params-variable',
            message: 'Teamwork Graph query must declare `$params: CypherRequestParams` and pass it to `cypherQuery(..., params: $params)`.',
        });
    }
    return violations;
}
function findFieldsInSelectionSet(selectionSet, fieldName, fragments, seenFragments = new Set()) {
    if (!selectionSet) {
        return [];
    }
    const fields = [];
    for (const selection of selectionSet.selections) {
        if (selection.kind === graphql_1.Kind.FIELD) {
            if (selection.name.value === fieldName) {
                fields.push(selection);
            }
            fields.push(...findFieldsInSelectionSet(selection.selectionSet, fieldName, fragments, seenFragments));
            continue;
        }
        if (selection.kind === graphql_1.Kind.INLINE_FRAGMENT) {
            fields.push(...findFieldsInSelectionSet(selection.selectionSet, fieldName, fragments, seenFragments));
            continue;
        }
        if (selection.kind === graphql_1.Kind.FRAGMENT_SPREAD) {
            const fragmentName = selection.name.value;
            if (seenFragments.has(fragmentName)) {
                continue;
            }
            const fragment = fragments.get(fragmentName);
            if (fragment) {
                seenFragments.add(fragmentName);
                fields.push(...findFieldsInSelectionSet(fragment.selectionSet, fieldName, fragments, seenFragments));
            }
        }
    }
    return fields;
}
function findDirectFieldsInSelectionSet(selectionSet, fieldName, fragments, seenFragments = new Set()) {
    if (!selectionSet) {
        return [];
    }
    const fields = [];
    for (const selection of selectionSet.selections) {
        if (selection.kind === graphql_1.Kind.FIELD && selection.name.value === fieldName) {
            fields.push(selection);
        }
        if (selection.kind === graphql_1.Kind.INLINE_FRAGMENT) {
            fields.push(...findDirectFieldsInSelectionSet(selection.selectionSet, fieldName, fragments, seenFragments));
        }
        if (selection.kind === graphql_1.Kind.FRAGMENT_SPREAD) {
            const fragmentName = selection.name.value;
            if (seenFragments.has(fragmentName)) {
                continue;
            }
            const fragment = fragments.get(fragmentName);
            if (fragment) {
                seenFragments.add(fragmentName);
                fields.push(...findDirectFieldsInSelectionSet(fragment.selectionSet, fieldName, fragments, seenFragments));
            }
        }
    }
    return fields;
}
function getArgumentValue(field, argumentName) {
    return field.arguments?.find((argument) => argument.name.value === argumentName)?.value;
}
function isVariable(value, variableName) {
    return value?.kind === graphql_1.Kind.VARIABLE && value.name.value === variableName;
}
function validateCypherQueryWrapper(operation, fragments) {
    const cypherFields = findFieldsInSelectionSet(operation.selectionSet, 'cypherQuery', fragments);
    if (!cypherFields.length) {
        return [
            {
                rule: 'twg-cypher-query-wrapper',
                message: 'Teamwork Graph requests must use the GraphQL `cypherQuery(query: $cypherQuery, params: $params)` wrapper.',
            },
        ];
    }
    const violations = [];
    for (const field of cypherFields) {
        if (!isVariable(getArgumentValue(field, 'query'), 'cypherQuery')) {
            violations.push({
                rule: 'twg-cypher-query-wrapper',
                message: '`cypherQuery` field must pass `query: $cypherQuery`.',
            });
        }
        if (!isVariable(getArgumentValue(field, 'params'), 'params')) {
            violations.push({
                rule: 'twg-cypher-query-wrapper',
                message: '`cypherQuery` field must pass `params: $params`.',
            });
        }
    }
    return violations;
}
function selectionSetHasField(selectionSet, fieldName) {
    return (selectionSet?.selections.some((selection) => selection.kind === graphql_1.Kind.FIELD && selection.name.value === fieldName) ?? false);
}
function validateValueTypenames(operation, fragments) {
    const valueFields = findFieldsInSelectionSet(operation.selectionSet, 'columns', fragments).flatMap((columnsField) => findDirectFieldsInSelectionSet(columnsField.selectionSet, 'value', fragments));
    const violations = [];
    for (const field of valueFields) {
        if (!field.selectionSet || !selectionSetHasField(field.selectionSet, '__typename')) {
            violations.push({
                rule: 'twg-require-typename',
                message: 'Teamwork Graph GraphQL selections must include `__typename` directly inside every `value { ... }` selection.',
            });
        }
    }
    return violations;
}
function validateVariables(variables) {
    if (!isRecord(variables)) {
        return {
            violations: [
                {
                    rule: 'twg-variables-object',
                    message: 'Teamwork Graph requests must pass a variables object containing `cypherQuery` and `params`.',
                },
            ],
        };
    }
    const violations = [];
    const cypherQuery = variables.cypherQuery;
    const params = variables.params;
    if (typeof cypherQuery !== 'string') {
        violations.push({
            rule: 'twg-cypher-query-variable-value',
            message: 'Teamwork Graph variables must include `cypherQuery` as a string.',
        });
    }
    if (!isRecord(params)) {
        violations.push({
            rule: 'twg-params-variable-value',
            message: 'Teamwork Graph variables must include `params` as an object. Use `{}` when the query has no parameters.',
        });
    }
    return { cypherQuery: typeof cypherQuery === 'string' ? cypherQuery : undefined, violations };
}
function stripCypherQuotedContent(cypherQuery) {
    return cypherQuery.replace(/(['"`])(?:\\.|(?!\1)[\s\S])*\1/g, '');
}
function stripCypherStringLiterals(cypherQuery) {
    return cypherQuery.replace(/(['"])(?:\\.|(?!\1)[\s\S])*\1/g, '');
}
function extractCypherParams(cypherQuery) {
    const params = new Set();
    for (const match of stripCypherQuotedContent(cypherQuery).matchAll(/\$([A-Za-z_][A-Za-z0-9_]*)/g)) {
        params.add(match[1]);
    }
    return params;
}
function validateCypherParams(cypherQuery, variables) {
    const params = isRecord(variables) && isRecord(variables.params) ? variables.params : undefined;
    const paramNames = extractCypherParams(cypherQuery);
    if (!params) {
        return [];
    }
    const violations = [];
    for (const paramName of paramNames) {
        if (!(paramName in params)) {
            violations.push({
                rule: 'twg-cypher-param-bound',
                message: `Cypher query references \`$${paramName}\`, but variables.params does not include \`${paramName}\`.`,
            });
        }
    }
    for (const paramName of Object.keys(params)) {
        if (!paramNames.has(paramName)) {
            violations.push({
                rule: 'twg-cypher-param-unused',
                message: `variables.params includes \`${paramName}\`, but the Cypher query does not reference \`$${paramName}\`.`,
            });
        }
    }
    return violations;
}
function validateLabelledRelationships(cypherQuery) {
    const violations = [];
    const relationshipPattern = /(<-|-\s*)(\[[^\]]*\])?\s*(->|-)/g;
    const cypherWithoutStringLiterals = stripCypherStringLiterals(cypherQuery);
    for (const match of cypherWithoutStringLiterals.matchAll(relationshipPattern)) {
        const relationship = match[2];
        if (!relationship || !/:\s*(?:[A-Za-z_][A-Za-z0-9_]*|`[^`]+`)/.test(relationship)) {
            violations.push({
                rule: 'twg-labelled-relationships',
                message: `Cypher relationship pattern \`${match[0].trim()}\` is missing a relationship label. ` +
                    'TWG requires `-[:relationship_label]->` style relationships.',
            });
        }
    }
    return violations;
}
function getHeaderValue(headers, name) {
    if (!headers) {
        return undefined;
    }
    const header = Object.entries(headers).find(([key]) => key.toLowerCase() === name);
    return header?.[1];
}
function isValidQueryContextAri(value) {
    const normalized = value.trim();
    const lowerValue = normalized.toLowerCase();
    return (TWG_QUERY_CONTEXT_ARI_PATTERN.test(normalized) &&
        !lowerValue.includes('undefined') &&
        !lowerValue.includes('null'));
}
function validateQueryContextHeader(headers, options) {
    const headerValue = getHeaderValue(headers, TWG_QUERY_CONTEXT_HEADER);
    if (headerValue === undefined) {
        return options.required
            ? [
                {
                    rule: 'twg-query-context-header',
                    message: 'Teamwork Graph `requestTeamworkGraph` calls must pass an `X-Query-Context` header. Use `req.context.installContext` as the header value.',
                },
            ]
            : [];
    }
    if (typeof headerValue !== 'string' || !isValidQueryContextAri(headerValue)) {
        return [
            {
                rule: 'twg-query-context-header',
                message: '`X-Query-Context` must be a valid Teamwork Graph context ARI from `req.context.installContext`, for example `ari:cloud:jira::site/<cloudId>`.',
            },
        ];
    }
    if (options.expectedQueryContext && headerValue.trim() !== options.expectedQueryContext) {
        return [
            {
                rule: 'twg-query-context-install-context',
                message: '`X-Query-Context` must match `req.context.installContext`. Use `req.context.installContext` instead of hardcoding or rebuilding the context ARI.',
            },
        ];
    }
    return [];
}
function validateTeamworkGraphRequestPayload(body) {
    if (!isRecord(body)) {
        return [
            {
                rule: 'twg-request-body',
                message: 'requestTeamworkGraph must receive a request body containing `query` and `variables`.',
            },
        ];
    }
    const parseResult = parseGraphql(body.query);
    if (!parseResult.parsed) {
        return parseResult.violations;
    }
    const selectedOperation = selectOperation(parseResult.parsed, body.operationName);
    if (!selectedOperation.operation) {
        return selectedOperation.violations;
    }
    const variableResult = validateVariables(body.variables);
    const violations = [
        ...parseResult.violations,
        ...selectedOperation.violations,
        ...validateOperationName(selectedOperation.operation),
        ...validateVariableDefinitions(selectedOperation.operation),
        ...validateCypherQueryWrapper(selectedOperation.operation, parseResult.parsed.fragments),
        ...validateValueTypenames(selectedOperation.operation, parseResult.parsed.fragments),
        ...variableResult.violations,
    ];
    if (variableResult.cypherQuery) {
        violations.push(...validateCypherParams(variableResult.cypherQuery, body.variables), ...validateLabelledRelationships(variableResult.cypherQuery));
    }
    return violations;
}
function validateTeamworkGraphRequest({ body, headers, expectedQueryContext, }) {
    return [
        ...validateTeamworkGraphRequestPayload(body),
        ...validateQueryContextHeader(headers, {
            required: true,
            expectedQueryContext,
        }),
    ];
}

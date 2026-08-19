import { ESLintUtils } from '@typescript-eslint/utils';
const createRule = ESLintUtils.RuleCreator(() => 'https://developer.atlassian.com/cloud/jira/platform/rest/v3/intro/');
/**
 * Jira REST API v2 is superseded by v3 for Forge apps. Unlike the
 * Confluence v1 -> v2 migration, there is no v2 sub-path that lacks a v3
 * equivalent, so this rule flags every `/rest/api/2/` occurrence rather than
 * maintaining an allow-list.
 *
 * Known limitation (shared with no-deprecated-search-endpoint): only string
 * Literal and TemplateLiteral nodes are checked, so a path built via string
 * concatenation (e.g. `'/rest/api/' + '2/' + endpoint`) is not detected.
 * Accepted trade-off consistent with the existing rule set; add a
 * BinaryExpression visitor if concatenation coverage is ever needed.
 */
const JIRA_REST_V2_PREFIX = '/rest/api/2/';
function containsJiraRestV2(value) {
    return value.includes(JIRA_REST_V2_PREFIX);
}
export const noJiraRestV2 = createRule({
    name: 'no-jira-rest-v2',
    meta: {
        type: 'problem',
        docs: {
            description: 'Disallow the Jira REST API v2 in favour of v3 for Forge apps',
        },
        messages: {
            jiraRestV2: 'Jira REST API v2 (/rest/api/2/) is superseded by v3 for Forge apps. Use /rest/api/3/ instead.',
        },
        schema: [],
    },
    defaultOptions: [],
    create(context) {
        return {
            Literal(node) {
                if (typeof node.value === 'string' && containsJiraRestV2(node.value)) {
                    context.report({ node, messageId: 'jiraRestV2' });
                }
            },
            TemplateLiteral(node) {
                for (const quasi of node.quasis) {
                    // Prefer the cooked value: for most literals raw and cooked are
                    // identical, but they diverge for escape sequences (e.g. a path
                    // containing \x2f-style escapes), where only the cooked value
                    // reflects the string's actual runtime content.
                    const value = quasi.value.cooked ?? quasi.value.raw;
                    if (containsJiraRestV2(value)) {
                        context.report({ node, messageId: 'jiraRestV2' });
                        return; // one report per template literal is enough
                    }
                }
            },
        };
    },
});

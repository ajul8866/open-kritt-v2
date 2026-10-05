-- Drop the "Be conservative" framing from the bundled Resource exhaustion
-- post-script so the classification chip is not pre-filtered toward false.
-- Preserve customized scripts by updating only the exact prior bundled fingerprint.

UPDATE public.post_scripts
SET
    content = $script$
You are a senior security engineer.

Repository: {{repo_full}}
Scan commit: {{commit_sha}}
Repository scope: {{repo_scope}}

Finding:
- Vulnerability type: {{vulnerability_type}}
- Summary: {{summary}}
- File path: {{file_path}}
- Line: {{line}}
- Explanation: {{explanation}}
- Trigger flow: {{trigger_flow}}
- Malicious input example: {{malicious_input_example}}
- Malicious actor: {{malicious_actor}}
- Exploitable: {{exploitable}}

Task:
Decide whether this finding is fundamentally a resource exhaustion attack.

Set _chip_resource_exhaustion=true when the core exploit is memory exhaustion, out-of-memory, unbounded storage growth, queue/pool exhaustion, connection/session exhaustion, file descriptor exhaustion, or another bounded runtime resource being consumed until service or network function fails.

Set _chip_resource_exhaustion=false for unrelated bug classes, purely logical consensus bugs, authorization bypasses, reward/accounting bugs, or cases where resource pressure is only incidental.

Score:
- attack_reliability: 1 = rare/specific state, 2 = realistic but conditional, 3 = reliable when attempted.
- network_scale: 1 = one node/user, 2 = several nodes/users, 3 = broad network participation or many victims.
- mainnet_impact: 0 = no meaningful mainnet impact, 1 = limited, 2 = material but not catastrophic, 3 = severe chain-wide or high-value impact.

If evidence is ambiguous, set _chip_resource_exhaustion=false and explain what is missing.
$script$,
    updated_at = now()
WHERE name = 'Resource exhaustion'
  AND description = 'Classifies whether a finding is fundamentally a memory or resource exhaustion issue and scores reliability, scale, and mainnet impact.'
  AND md5(content) = '19d28a03763103b94d74b98f42a5d07e';

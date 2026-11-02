# How Much Safer

A comparison of exposure against a conventional host, and the sources it rests on.

## How Much Safer

No study compares breach outcomes for serverless and server hosting. The attack-surface literature
(Manadhata and Wing, IEEE TSE 2011, and Howard's relative attack surface quotient) defines how to
count entry points and capabilities, and neither measures this pair. The vendor surveys searched
quote percentages that were read only through summaries, so none is repeated here.

What can be counted is the two tables above. Every sentence on this page that says Drupflare is more
resistant than a VPS to a class is Inferred from the architecture until the three-arm comparison
below has a result.

The 24 rows of the [incident map](incidents.md#the-cve-and-incident-map) carry these verdicts:

| Verdict   | Rows | Meaning                                                                       |
| --------- | ---- | ----------------------------------------------------------------------------- |
| removed   | 12   | The attack path needs a component the object lacks                            |
| contained | 4    | The flaw runs; the sandbox limits the reach                                   |
| open      | 8    | The flaw works as it does anywhere, or it could not be established either way |

The [v1.0.4 class table](incidents.md#classes-addressed-in-v104) has 19 rows: 4 move from `open` to `removed`, 13 to `contained`, and 2 stay
`open`. Read the `removed` counts as statements about classes of server takeover and published exploit chains, and do not read
them as a breach probability. The incident rows were chosen from incidents that reached the attacker's goal on conventional
PHP hosting, so the selection favours the classes this architecture removes. None of the six Drupal
advisories in the map is `removed`: each is `contained` or `open`, because Drupal's own bugs
run inside the sandbox. Sophos's 2025 education survey reports that higher education providers were
more likely to be attacked through exploited vulnerabilities (35%), from 441 respondents across
lower and higher education
([Sophos](https://www.sophos.com/en-us/blog/the-state-of-ransomware-in-education-2025)). The
figure concerns the entry vector and says nothing about the host.

The measurable form of the claim is a comparison of authority retained after the same exploit. The
planned experiment runs one pinned vulnerable Drupal against three arms (a minimally configured
VPS, a hardened container and Drupflare) with a fixed list of post-exploitation actions, and
publishes how many each arm blocked.

## References

Each source was read through a page extractor unless its entry says abstract or extract.

1. Cloudflare, Workers security model: <https://developers.cloudflare.com/workers/reference/security-model/>
2. Cloudflare, "A revisit of remote Spectre attacks on Cloudflare Workers", 2026-08-19: <https://blog.cloudflare.com/revisiting-spectre-attacks-on-workers/>
3. Schwarzl et al., "Remote-Timer-as-a-Service", arXiv:2608.17043 (abstract only): <https://arxiv.org/abs/2608.17043>
4. Cloudflare, Cloudbleed incident report, 2017-02-23: <https://blog.cloudflare.com/incident-report-on-memory-leak-caused-by-cloudflare-parser-bug/>
5. Cloudflare, 12 June 2025 service outage: <https://blog.cloudflare.com/cloudflare-service-outage-june-12-2025/>
6. Cloudflare, 18 November 2025 outage: <https://blog.cloudflare.com/18-november-2025-outage/>
7. Lehmann, Kinder and Pradel, "Everything Old is New Again: Binary Security of WebAssembly", USENIX Security 2020 (abstract): <https://www.usenix.org/conference/usenixsecurity20/presentation/lehmann>
8. Stiévenart, De Roover and Ghafari, "The Security Risk of Lacking Compiler Protection in WebAssembly", arXiv:2111.01421 (abstract): <https://arxiv.org/abs/2111.01421>
9. WebAssembly security documentation: <https://webassembly.org/docs/security/>
10. Google Threat Intelligence Group, "2025 Zero-Days in Review", 2026-03-05: <https://cloud.google.com/blog/topics/threat-intelligence/2025-zero-day-review/>
11. PHP project, security advisory 2026-10-21 (CVE-2026-109618, CVE-2026-109619) and the two php-src advisories GHSA-w8hw-w9fx-j79w and GHSA-6wmf-4rv5-p3rp: <https://www.php.net/archive/2026.php#2026-10-21-5>
12. Wiz, "PHP2Shell: AI uncovers critical RCE vulnerabilities" (read once through a page extractor): <https://www.wiz.io/blog/php2shell-php-rce>
13. Drupal security advisories SA-CORE-2014-005, 2018-002, 2018-004, 2019-003, 2020-004 and 2026-014: <https://www.drupal.org/security>
14. NVD records for the CVE identifiers in the map: <https://nvd.nist.gov/>
15. PHP project, 2021 archive (malicious commits, 2021-03-30): <https://www.php.net/archive/2021.php>
16. Sophos, "The State of Ransomware in Education 2025": <https://www.sophos.com/en-us/blog/the-state-of-ransomware-in-education-2025>
17. workerd README, "WARNING: workerd is not a hardened sandbox": <https://github.com/cloudflare/workerd>
18. Check Point Research, workerd and Code Mode research, 2026-08-07 (read as an extract): <https://research.checkpoint.com/2026/when-agentic-glue-melts/>
19. CISA, "Widespread supply chain compromise impacting npm ecosystem", 2025-09-23 (extract): <https://www.cisa.gov/news-events/alerts/2025/09/23/widespread-supply-chain-compromise-impacting-npm-ecosystem>
20. Cloudflare, Durable Object platform limits (key and value size): <https://developers.cloudflare.com/durable-objects/platform/limits>

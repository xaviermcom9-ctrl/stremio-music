// Node tries a host's addresses in parallel ("happy eyeballs") but gives each attempt only 250 ms.
// From Australia, TLS servers in Europe take longer than that, so IPv4 times out while IPv6 isn't
// routable inside Docker: every request fails. Give each attempt 2.5 s. Import this first.
import net from 'node:net';

export const AUTOSELECT_ATTEMPT_TIMEOUT_MS = 2500;

net.setDefaultAutoSelectFamilyAttemptTimeout(AUTOSELECT_ATTEMPT_TIMEOUT_MS);

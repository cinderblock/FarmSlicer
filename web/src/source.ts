// The "Source code" link (the AGPL's §13: people using FarmSlicer over a
// network are offered its source). The server says where the source is
// (`source_url` in /api/auth/status, set by FARMSLICER_SOURCE_URL); its
// `{commit}` becomes the commit this build came from.

import { BUILD_COMMIT } from "./build";

const DEFAULT = "https://github.com/cinderblock/FarmSlicer/tree/{commit}";

/** The link for this build: the template with its commit, else the branch. */
export function sourceUrl(template: string | null | undefined, commit: string = BUILD_COMMIT): string {
  return (template || DEFAULT).replaceAll("{commit}", commit || "master");
}

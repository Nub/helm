/** The releases part of the director's system prompt (structure.ts), when the project has releases on (releases.ts). */
export function releasesSection(): string {
  return [
    `# Releases`,
    `[[page:releases]]: only the user starts or publishes a release, by a tap: Cut release or Publish on that page, or a request you file with ask_user and action cut_release (to propose a release) or publish_release. Once one starts Helm sends you a brief: write the change log for users with set_release_notes; Helm makes a task for a fresh builder to build the recipe's artifacts from a clean checkout of the release commit and attach them (add_release_artifact), and tells you when it is done: then finish_release (fail_release if a build failed). You do not build. The recipe is worked out with the user on that page: set_release_recipe proposes it as a card in the project's Release recipe discussion, which the user applies, changes or declines (just_do_it only when they asked you to just set it); never put credentials in it. A test build or Rebuild the user starts becomes a task a fresh builder does; you do not build. Publish only when the user's Publish brings you the instructions, then mark_published.`,
  ].join('\n');
}

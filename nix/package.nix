{
  lib,
  buildNpmPackage,
  importNpmLock,
  nodejs_24,
  makeWrapper,
  # The commit this is built from (the flake passes self.rev), written to lib/helm/version.json for the server. Run
  # from a checkout (`node server/main.ts`) there is no version.json and the server reports "dev".
  rev ? "unknown",
  shortRev ? "unknown",
  lastModified ? 0,
}: let
  nodejs = nodejs_24;
  package = lib.importJSON ../package.json;
  lock = lib.importJSON ../package-lock.json;

  # The Agent SDK's optional per-platform packages each carry a prebuilt Claude Code binary (hundreds of MB, and
  # they don't run on NixOS anyway: Helm is pointed at the host's claude through HELM_CLAUDE_PATH). Leaving them
  # out of the lock means they are never downloaded and npm skips them as missing optional dependencies.
  isClaudeBinary = name: lib.hasPrefix "node_modules/@anthropic-ai/claude-agent-sdk-" name;
  sdk = "node_modules/@anthropic-ai/claude-agent-sdk";
  packageLock =
    lock
    // {
      packages =
        lib.filterAttrs (name: _: !isClaudeBinary name) lock.packages
        // lib.optionalAttrs (lock.packages ? ${sdk}) {
          ${sdk} = removeAttrs lock.packages.${sdk} ["optionalDependencies"];
        };
    };
in
  buildNpmPackage {
    pname = "helm";
    inherit (package) version;
    inherit nodejs;

    src = lib.fileset.toSource {
      root = ../.;
      fileset = lib.fileset.unions [
        ../package.json
        ../package-lock.json
        ../tsconfig.json
        ../server
        (lib.fileset.difference ../web (lib.fileset.maybeMissing ../web/dist))
      ];
    };

    # Every dependency is fetched by its lockfile integrity hash, so there is no npmDepsHash to refresh when
    # package-lock.json changes.
    npmDeps = importNpmLock {
      npmRoot = ../.;
      inherit package packageLock;
    };
    npmConfigHook = importNpmLock.npmConfigHook;

    # Only the web app is built; the server runs its TypeScript directly through Node's type stripping.
    npmBuildScript = "build";

    nativeBuildInputs = [makeWrapper];

    installPhase = ''
      runHook preInstall

      npm prune --omit=dev --no-save --ignore-scripts
      rm -rf node_modules/.bin

      root=$out/lib/helm
      mkdir -p $root/web $out/bin
      cp -r package.json server node_modules $root/
      cp -r web/dist $root/web/
      echo ${lib.escapeShellArg (builtins.toJSON {inherit rev shortRev lastModified;})} > $root/version.json
      # The runner's code as one hash, and its files (server/closure.ts): an update whose build has the same hash
      # restarts only the web service, and agents keep working (nix/live-update.sh).
      ${lib.getExe nodejs} server/closure.ts . --out $root/runner.json

      # APP_ROOT (server/config.ts) is the folder above server/, so web/dist is found next to it. Everything Helm
      # writes goes to HELM_DATA, which defaults to ~/.helm, never here.
      # `helm` runs everything in one process; `helm runner` and `helm web` are the two halves (server/main.ts).
      makeWrapper ${lib.getExe nodejs} $out/bin/helm \
        --chdir $root \
        --add-flags $root/server/main.ts

      runHook postInstall
    '';

    passthru = {inherit nodejs;};

    meta = {
      description = "Self-hosted dashboard for directing long-lived Claude agent projects";
      mainProgram = "helm";
      platforms = lib.platforms.linux;
    };
  }

{
  config,
  lib,
  pkgs,
  ...
}: let
  inherit (lib) mkEnableOption mkIf mkMerge mkOption optionalAttrs types;
  cfg = config.services.helm;
  lu = cfg.liveUpdate;
  liveDir = "${cfg.dataDir}/live";

  # What helm.service runs with live update on: the build the current link points at, if there is one, else the
  # packaged build. The link is replaced only by helm-live-update, after a successful build.
  start = pkgs.writeShellScript "helm-start" ''
    if [ -x ${lib.escapeShellArg liveDir}/current/bin/helm ]; then
      exec ${lib.escapeShellArg liveDir}/current/bin/helm "$@"
    fi
    exec ${lib.getExe cfg.package} "$@"
  '';

  liveUpdateScript = pkgs.writeShellApplication {
    name = "helm-live-update";
    runtimeInputs = [config.nix.package pkgs.git pkgs.jq pkgs.curl pkgs.coreutils pkgs.util-linux pkgs.gnugrep pkgs.gnused config.systemd.package];
    # Checked by shellcheck at build time; the script handles errors itself rather than through errexit.
    bashOptions = ["nounset" "pipefail"];
    text = builtins.readFile ./live-update.sh;
  };

  liveUpdateEnv = {
    HELM_LU_DIR = liveDir;
    HELM_LU_FLAKE = lu.flake;
    HELM_LU_ATTR = lu.attr;
    HELM_LU_PACKAGE = "${cfg.package}";
    HELM_LU_SERVICE = "helm.service";
    HELM_LU_SCOPE = "system";
    HELM_LU_URL = upstream;
    HELM_LU_TIMEOUT = toString lu.healthTimeout;
    HELM_LU_KEEP = toString lu.keep;
    HOME = home;
  };

  liveUpdateUnit = mode: {
    description =
      if mode == "update"
      then "Build Helm from ${lu.flake} and switch to it"
      else "Switch Helm back to its previous build";
    # Not wanted by anything: started on request (the dashboard's Update / Roll back, or systemctl start).
    environment = liveUpdateEnv;
    serviceConfig = {
      Type = "oneshot";
      # Built and switched as the service user: nix builds through the daemon, the links live in its data dir.
      # Restarting helm.service is the one privileged step, allowed for this user by the polkit rule below.
      User = cfg.user;
      Group = cfg.group;
      WorkingDirectory = home;
      ExecStart = "${lib.getExe liveUpdateScript} ${mode}";
      # A first build can download a lot.
      TimeoutStartSec = "1h";
    };
  };
  home = config.users.users.${cfg.user}.home;
  # nginx always reaches the server over loopback, even when it also listens on the LAN.
  upstream = "http://${
    if cfg.host == "0.0.0.0" || cfg.host == "::"
    then "127.0.0.1"
    else cfg.host
  }:${toString cfg.port}";
  # Set by hand rather than through recommendedProxySettings, so the headers are the same whatever the host's
  # nginx defaults are and are never sent twice.
  proxyHeaders = ''
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-Host $host;
  '';
  # X-Helm-Signed-In tells Helm the request passed the sign-in gate (nginx.signedInBy). Every location sets it
  # itself, to 1 behind the gate and to "" (not sent) everywhere else, so whatever a client sent never reaches Helm.
  # Each location carries the whole header list: a location with any proxy_set_header inherits none from above.
  signedIn = passedGate: ''
    proxy_set_header X-Helm-Signed-In "${
      if passedGate && cfg.nginx.signedInBy != null
      then "1"
      else ""
    }";
  '';
  proxyTo = extra: {
    proxyPass = upstream;
    proxyWebsockets = true;
    recommendedProxySettings = false;
    extraConfig = proxyHeaders + signedIn false + extra;
  };
  gated = extra: {
    proxyPass = upstream;
    proxyWebsockets = true;
    recommendedProxySettings = false;
    extraConfig = proxyHeaders + signedIn true + extra + cfg.nginx.locationExtraConfig;
  };
in {
  options.services.helm = {
    enable = mkEnableOption "Helm, the dashboard for directing Claude agent projects";

    package = mkOption {
      type = types.package;
      description = "The Helm package. The flake's nixosModules.default sets it to the flake's own build.";
    };

    user = mkOption {
      type = types.str;
      example = "alice";
      description = ''
        The existing account Helm and every agent it starts run as. Agents work in this user's home with its git
        and ssh keys, nix and Claude login (~/.claude), so it is a real login user, not a service account.
      '';
    };

    group = mkOption {
      type = types.str;
      default = config.users.users.${cfg.user}.group;
      defaultText = lib.literalExpression "config.users.users.\${config.services.helm.user}.group";
      description = "Group the service runs as.";
    };

    port = mkOption {
      type = types.port;
      default = 8080;
      description = "Port the web UI and API listen on.";
    };

    host = mkOption {
      type = types.str;
      default = "127.0.0.1";
      description = "Address to listen on. Use 0.0.0.0 to reach Helm directly from the local network as well.";
    };

    dataDir = mkOption {
      type = types.str;
      default = "${home}/.helm";
      defaultText = lib.literalExpression ''"''${config.users.users.''${config.services.helm.user}.home}/.helm"'';
      description = "Helm's database, config.json (passphrase) and preview files. Helm's own default, so existing data is kept.";
    };

    projectsRoot = mkOption {
      type = types.nullOr types.str;
      default = null;
      description = "Where new and cloned projects are created. Unset means projectsRoot in dataDir/config.json.";
    };

    claudePath = mkOption {
      type = types.str;
      default = "/run/current-system/sw/bin/claude";
      description = "The Claude Code binary agents run (the SDK's bundled one doesn't run on NixOS).";
    };

    extraPath = mkOption {
      type = types.listOf types.package;
      default = [];
      example = lib.literalExpression "[ pkgs.gh pkgs.ripgrep ]";
      description = "Extra packages on the PATH of Helm and its agents, after the user's profile and the system's.";
    };

    environment = mkOption {
      type = types.attrsOf types.str;
      default = {};
      description = "Extra environment variables for Helm and its agents (e.g. HELM_IDLE_SECONDS).";
    };

    attachmentMaxMB = mkOption {
      type = types.ints.positive;
      default = 50;
      description = ''
        Largest file the user may attach to a Spec entry, task or message, in MB (HELM_ATTACH_MAX_MB). The nginx
        proxy accepts that much on the upload endpoint, and only there; other requests keep the 10 MB limit.
      '';
    };

    lanNoLogin = mkOption {
      type = types.bool;
      default = false;
      description = ''
        Let clients on the local network in without the passphrase (HELM_LAN_NO_LOGIN). A request qualifies when it
        comes from a loopback or private address (behind the nginx proxy: the client address nginx reports), names
        this machine in its Host header, and is not a cross-site browser request; anything else still needs the
        passphrase. This means anyone who can reach the port from a private address, and any program on this
        machine, controls agents that run commands as ${cfg.user}, with no password. Only turn it on for a network
        where every device and person is trusted.
      '';
    };

    lanAllowedHosts = mkOption {
      type = types.listOf types.str;
      default = [];
      example = ["buildbox.lan:8080" "helm.example.com"];
      description = ''
        Extra Host header values (name, or name:port when not the default port) accepted for lanNoLogin, besides the
        machine's hostname, <hostname>.local, localhost and its own addresses with the configured port. Add the nginx
        domain to let a LAN client that reaches it through the proxy in without the passphrase.
      '';
    };

    openFirewall = mkOption {
      type = types.bool;
      default = false;
      description = "Open the port in the firewall (for direct access from the network, with host = 0.0.0.0).";
    };

    liveUpdate = {
      enable = mkOption {
        type = types.bool;
        default = false;
        description = ''
          Update Helm without a system rebuild. helm.service then starts the build that dataDir/live/current points
          at (falling back to `package`), and `systemctl start helm-update` (or Update in the dashboard) builds
          `flake#attr` as the service user, switches to it, restarts Helm and rolls back if it does not come up healthy
          within healthTimeout; `systemctl start helm-rollback` switches back to the previous build.

          What this grants: a polkit rule lets the service user start helm-update.service and helm-rollback.service and
          restart helm.service without a password. The service user, and therefore every agent Helm runs, can then
          replace Helm's code with whatever the release branch holds and restart it (interrupting every agent). They
          could already run arbitrary code as that user and edit the repository; this adds the restart of a system
          service. Changes to this module or to the NixOS config (options, nginx, PATH packages) still need a rebuild.
        '';
      };

      repo = mkOption {
        type = types.str;
        example = "/home/alice/src/helm";
        description = "The Helm git repository. The dashboard reads it (git rev-parse, git log) to show what an update would bring.";
      };

      ref = mkOption {
        type = types.str;
        default = "release";
        description = "Branch of `repo` that is deployed.";
      };

      flake = mkOption {
        type = types.str;
        default = "git+file://${lu.repo}?ref=${lu.ref}";
        defaultText = lib.literalExpression ''"git+file://''${repo}?ref=''${ref}"'';
        description = "Flake an update builds. If you point it elsewhere, the dashboard's view of what is available (repo and ref) no longer matches.";
      };

      attr = mkOption {
        type = types.str;
        default = "default";
        description = ''
          Package attribute of `flake` to build (packages.<system>.<attr>). It is built with the Helm flake's own
          locked nixpkgs, not overridden with the system's: Nix drops self.rev from a flake whose inputs are
          overridden, and the baked-in revision is how the dashboard and the health check know what is running. So a
          live build's Node comes from the Helm repo's flake.lock, which can differ from the one-time system build's
          when the system flake sets helm.inputs.nixpkgs.follows.
        '';
      };

      keep = mkOption {
        type = types.ints.positive;
        default = 5;
        description = "Builds to keep in dataDir/live/generations (each a GC root). The current and previous ones are always kept.";
      };

      healthTimeout = mkOption {
        type = types.ints.positive;
        default = 60;
        description = "Seconds the new build has to answer on / and /api/health with its own revision before it is rolled back.";
      };
    };

    disk = {
      housekeeping = mkEnableOption ''
        keeping the machine's disk from filling, done the Nix way: a weekly garbage collection of store paths and
        system generations older than `gcOlderThan`, Nix collecting garbage during builds when free space drops below
        `minFreeGB` (until `maxFreeGB` is free), a weekly store optimisation (hard-linking identical files), a limit
        on boot entries kept (systemd-boot or GRUB, whichever is enabled), and ageing of /tmp. Agents build a lot: on
        2026-11-18 the disk filled and took Helm down with it. These are machine-wide settings, set with mkDefault so
        the host's own configuration wins'';

      gcOlderThan = mkOption {
        type = types.str;
        default = "14d";
        description = "Weekly nix.gc deletes generations (and with them store paths) older than this.";
      };

      minFreeGB = mkOption {
        type = types.ints.positive;
        default = 20;
        description = "nix.settings.min-free: when a build leaves less than this free, Nix collects garbage at once.";
      };

      maxFreeGB = mkOption {
        type = types.ints.positive;
        default = 60;
        description = "nix.settings.max-free: how much that collection frees, at most.";
      };

      bootEntries = mkOption {
        type = types.ints.positive;
        default = 20;
        description = "Boot menu entries (system generations) the bootloader keeps; older generations stop being GC roots through it.";
      };

      tmpAge = mkOption {
        type = types.str;
        default = "7d";
        description = ''
          /tmp is for throwaway files only: files in it not modified or accessed for this long are deleted by
          systemd-tmpfiles, even inside a folder still in use (the age is per file). NixOS's own default is 10 days.
        '';
      };
    };

    nginx = {
      enable = mkEnableOption "an nginx HTTPS reverse proxy for Helm";

      domain = mkOption {
        type = types.str;
        example = "helm.example.com";
        description = "Name of the nginx virtual host.";
      };

      useACMEHost = mkOption {
        type = types.nullOr types.str;
        default = null;
        description = "An existing security.acme cert (e.g. a wildcard) to use. Unset means a cert of its own via enableACME.";
      };

      extraConfig = mkOption {
        type = types.lines;
        default = "";
        description = "Server-level nginx config for the virtual host, e.g. set_real_ip_from for a CDN in front of it.";
      };

      locationExtraConfig = mkOption {
        type = types.lines;
        default = "";
        example = "auth_request /_signin_check;";
        description = ''
          Config added to every location that reaches Helm (not the PWA manifest and icons, which browsers fetch
          without cookies), e.g. an auth_request gate. Further locations, such as the gate's own, can be added
          through services.nginx.virtualHosts.<domain>.locations.
        '';
      };

      signedInBy = mkOption {
        type = types.nullOr types.str;
        default = null;
        example = "docs.example.com";
        description = ''
          Name of the sign-in gate in locationExtraConfig (shown in the UI as "Signed in through <name>"). Set, Helm
          skips its passphrase for requests that passed the gate: nginx sends X-Helm-Signed-In: 1 on gated locations
          (and clears it on all others), and Helm believes it only from a loopback peer (HELM_TRUST_PROXY_SIGNIN).
          Whoever the gate lets through then controls agents that run commands as the service user, so the gate must
          admit only people who may do that. In particular, a gate that waves through the local network without a
          sign-in makes this as open as lanNoLogin for anyone on the LAN who opens the domain.
        '';
      };
    };
  };

  config = mkIf cfg.enable (mkMerge [
    {
      assertions = [
        {
          assertion = cfg.nginx.signedInBy == null || (cfg.nginx.enable && cfg.nginx.locationExtraConfig != "");
          message = "services.helm.nginx.signedInBy needs nginx.enable and a sign-in gate in nginx.locationExtraConfig (e.g. auth_request).";
        }
      ];

      systemd.services.helm = {
        description = "Helm agent dashboard";
        wantedBy = ["multi-user.target"];
        after = ["network-online.target"];
        wants = ["network-online.target"];

        environment =
          {
            HOME = home;
            # Agents run commands as this user, so they get what a login shell would: setuid wrappers first (sudo
            # must be the setuid one), then the user's and the system's profiles. Helm's own node comes after those.
            PATH = lib.mkForce (lib.concatStringsSep ":" ([
                "/run/wrappers/bin"
                "/etc/profiles/per-user/${cfg.user}/bin"
                "/run/current-system/sw/bin"
                "${cfg.package.nodejs}/bin"
              ]
              ++ map (p: "${lib.getBin p}/bin") cfg.extraPath
              # git for the dashboard's view of what an update would bring (server/liveupdate.ts).
              ++ lib.optional lu.enable "${pkgs.git}/bin"));
            HELM_PORT = toString cfg.port;
            HELM_HOST = cfg.host;
            HELM_DATA = cfg.dataDir;
            HELM_CLAUDE_PATH = cfg.claudePath;
            HELM_ATTACH_MAX_MB = toString cfg.attachmentMaxMB;
            NODE_NO_WARNINGS = "1";
          }
          // optionalAttrs (cfg.projectsRoot != null) {HELM_PROJECTS = cfg.projectsRoot;}
          // optionalAttrs cfg.lanNoLogin {HELM_LAN_NO_LOGIN = "1";}
          // optionalAttrs (cfg.nginx.enable && cfg.nginx.signedInBy != null) {HELM_TRUST_PROXY_SIGNIN = cfg.nginx.signedInBy;}
          // optionalAttrs (cfg.lanAllowedHosts != []) {HELM_LAN_ALLOWED_HOSTS = lib.concatStringsSep "," cfg.lanAllowedHosts;}
          // optionalAttrs lu.enable {
            # Read by server/liveupdate.ts: where to look for what is available, and which units to start.
            HELM_LIVE_UPDATE_REPO = lu.repo;
            HELM_LIVE_UPDATE_REF = lu.ref;
            HELM_LIVE_UPDATE_DIR = liveDir;
          }
          // cfg.environment;

        serviceConfig = {
          User = cfg.user;
          Group = cfg.group;
          WorkingDirectory = home;
          ExecStart =
            if lu.enable
            then start
            else lib.getExe cfg.package;
          Restart = "on-failure";
          RestartSec = 3;
          # On stop only Helm gets SIGTERM: it closes its agents' Claude processes itself, then whatever is left in
          # the cgroup (an agent's stray dev server, say) is killed, so a restart never leaves orphans behind.
          KillMode = "mixed";
          TimeoutStopSec = 30;
          # Deliberately no sandboxing (ProtectHome, ProtectSystem, PrivateTmp, NoNewPrivileges, ...): agents are
          # this user doing real work, and need the whole home, ssh keys, nix, git, sudo and the Claude login.
        };
      };

      networking.firewall.allowedTCPPorts = mkIf cfg.openFirewall [cfg.port];
    }

    (mkIf lu.enable {
      systemd.services.helm-update = liveUpdateUnit "update";
      systemd.services.helm-rollback = liveUpdateUnit "rollback";

      # The one privilege live update needs: the service user may start the two units above and restart Helm, and
      # nothing else (no other units, no stop, no enable, no unit-file changes). See liveUpdate.enable.
      security.polkit.enable = true;
      security.polkit.extraConfig = ''
        // services.helm.liveUpdate: ${cfg.user} may start helm-update / helm-rollback and restart helm.
        polkit.addRule(function(action, subject) {
          if (action.id != "org.freedesktop.systemd1.manage-units" || subject.user != ${builtins.toJSON cfg.user}) {
            return polkit.Result.NOT_HANDLED;
          }
          var unit = action.lookup("unit");
          var verb = action.lookup("verb");
          if ((unit == "helm-update.service" || unit == "helm-rollback.service") && verb == "start") {
            return polkit.Result.YES;
          }
          if (unit == "helm.service" && verb == "restart") {
            return polkit.Result.YES;
          }
          return polkit.Result.NOT_HANDLED;
        });
      '';
    })

    (mkIf cfg.disk.housekeeping {
      nix.gc = {
        automatic = lib.mkDefault true;
        dates = lib.mkDefault "weekly";
        options = lib.mkDefault "--delete-older-than ${cfg.disk.gcOlderThan}";
      };
      nix.settings.min-free = lib.mkDefault (cfg.disk.minFreeGB * 1024 * 1024 * 1024);
      nix.settings.max-free = lib.mkDefault (cfg.disk.maxFreeGB * 1024 * 1024 * 1024);
      nix.optimise.automatic = lib.mkDefault true;
      boot.loader.systemd-boot.configurationLimit = mkIf config.boot.loader.systemd-boot.enable (lib.mkDefault cfg.disk.bootEntries);
      boot.loader.grub.configurationLimit = mkIf config.boot.loader.grub.enable (lib.mkDefault cfg.disk.bootEntries);
      # Read before systemd's own tmp.conf (Q /tmp ... 10d): for the same path the earliest file wins. Not combined with
      # boot.tmp.cleanOnBoot, whose D! line for /tmp would conflict with this one in the same file.
      systemd.tmpfiles.rules = ["q /tmp 1777 root root ${cfg.disk.tmpAge}"];
    })

    (mkIf cfg.nginx.enable {
      services.nginx = {
        enable = true;
        # Logins per client address: a few a minute, then 429. With a CDN in front, nginx.extraConfig must set the
        # real client address or this limits the CDN instead.
        appendHttpConfig = ''
          limit_req_zone $binary_remote_addr zone=helm_login:1m rate=5r/m;
        '';
        virtualHosts.${cfg.nginx.domain} = {
          forceSSL = true;
          useACMEHost = cfg.nginx.useACMEHost;
          enableACME = cfg.nginx.useACMEHost == null;
          extraConfig =
            ''
              # The API takes JSON bodies up to 8 MB (bodyLimit in server/main.ts).
              client_max_body_size 10m;
            ''
            + cfg.nginx.extraConfig;
          locations."/" = gated "";
          # Attachment uploads (server/attachments.ts): the web app sends one file per request, so one file's limit
          # plus room for the multipart framing. Streamed to Helm as it arrives instead of spooled to disk first;
          # Helm enforces the exact limit itself.
          locations."~ ^/api/projects/[^/]+/attachments$" = gated ''
            client_max_body_size ${toString (cfg.attachmentMaxMB + 1)}m;
            proxy_request_buffering off;
            proxy_read_timeout 15m;
            proxy_send_timeout 15m;
          '';
          # Live updates are a server-sent-events stream that stays open: pass every event through at once.
          locations."= /api/stream" = gated ''
            proxy_buffering off;
            proxy_cache off;
            gzip off;
            proxy_read_timeout 24h;
            proxy_send_timeout 24h;
          '';
          locations."= /api/login" = gated ''
            limit_req zone=helm_login burst=5 nodelay;
            limit_req_status 429;
          '';
          # Static and public: browsers fetch the web app manifest (and with it the icons) without cookies.
          locations."= /manifest.webmanifest" = proxyTo "";
          locations."= /icon.svg" = proxyTo "";
          locations."= /apple-touch-icon.png" = proxyTo "";
          locations."= /icon-192.png" = proxyTo "";
          locations."= /icon-512.png" = proxyTo "";
          locations."= /icon-maskable-512.png" = proxyTo "";
        };
      };
    })
  ]);
}

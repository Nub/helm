{
  description = "Helm: a self-hosted dashboard for directing long-lived Claude agent projects";

  # A consumer can share its own nixpkgs with `helm.inputs.nixpkgs.follows = "nixpkgs";`.
  inputs.nixpkgs.url = "github:nixos/nixpkgs/nixos-unstable";

  outputs = {
    self,
    nixpkgs,
  }: let
    systems = ["x86_64-linux" "aarch64-linux"];
    forAll = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});
  in {
    packages = forAll (pkgs: {
      # The commit it was built from is baked in (lib/helm/version.json), so the running server can say what it is
      # and compare itself with the release branch. A dirty tree reports its dirty revision.
      default = pkgs.callPackage ./nix/package.nix {
        rev = self.rev or self.dirtyRev or "unknown";
        shortRev = self.shortRev or self.dirtyShortRev or "unknown";
        lastModified = self.lastModified or 0;
      };
    });

    # services.helm, with the package defaulting to this flake's build for the host's platform.
    nixosModules.default = {pkgs, lib, ...}: {
      imports = [./nix/module.nix];
      services.helm.package = lib.mkDefault self.packages.${pkgs.stdenv.hostPlatform.system}.default;
    };
  };
}

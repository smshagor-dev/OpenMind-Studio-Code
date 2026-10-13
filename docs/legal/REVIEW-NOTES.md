# Legal documents: points for the owner and legal review (not shipped)

These documents were written from the program's actual behaviour (code and docs as of 13 October 2026), not from a
template, and have **not** been reviewed by a lawyer. Before publication, please confirm:

1. **Licensor identity.** The documents name "Md Shahanur Islam Shagor, publishing as OpenMind". No company registration
   was invented. If OpenMind is (or becomes) a legal entity, replace the name and add its address/registration.
2. **Apache-2.0 vs. private source.** The program is licensed Apache-2.0 (`LICENSE`, `bundle.license`, `package.json`).
   Apache-2.0 does not require publishing source code, so a private source repository is consistent with it, but anyone
   who obtains the source may redistribute it under Apache-2.0. If you intend proprietary licensing, the licence itself
   must change (this is a decision for you and counsel, not a wording change). The EULA deliberately adds no restriction
   beyond Apache-2.0, because it can't take away rights Apache-2.0 grants.
3. **Effective date.** "the publication date of OpenMind Studio 1.0.3". Replace with the actual date when published.
4. **Jurisdiction / governing law.** None is stated (no jurisdiction was given). Add one if counsel recommends it.
5. **GDPR/CCPA wording.** The policy describes processing truthfully but makes no claim of compliance with any specific
   law and names no data-protection officer or legal basis. Counsel may want a legal-basis section if EU users are
   targeted.
6. **Linux/macOS secrets.** The policy states that secrets are stored unencrypted there (true today). Update it when
   keychain/libsecret storage lands.
7. **Update check cannot be turned off.** True today; the policy says so. If a switch is added, update section 3.1.
8. **Collaboration.** Transport encryption (DTLS) is claimed; end-to-end encryption is **not** claimed (the room's host
   stores documents and a classroom voice server relays audio).
9. **Russian translations** of these documents do not exist yet; the installers show English only (the NSIS installer's
   only language is English).

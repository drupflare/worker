# Documentation

The published site is [docs.drupflare.com](https://docs.drupflare.com). Each folder has an `index.md` that lists its pages.

| folder                                       | holds                                                                                                  |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| [getting-started/](getting-started/index.md) | install, claim and update a site; build from source; repository layout; testing                        |
| [operating/](operating/index.md)             | administration, recovery, git remotes, external databases, interpreter updates, replica lanes          |
| [architecture/](architecture/index.md)       | how a request is answered; measurement classes; the site database; compatibility; limitations; modules |
| [configuration/](configuration/index.md)     | every variable and binding, by area                                                                    |
| [security/](security/index.md)               | what the architecture removes and leaves, the controls in place, incidents                             |
| [impact/](impact/index.md)                   | energy, carbon, water, economics, the labels and references behind each figure                         |
| [audiences/](audiences/index.md)             | pages for a specific procurement or compliance reader                                                  |

The generator reads every other `.md` file under this directory as a page. This file is a map for the repository and is not published. How pages, folders and moves work is in [Repository Layout](getting-started/repository-layout/paths.md#docs).

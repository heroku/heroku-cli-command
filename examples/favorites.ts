import {ux} from '@oclif/core'

import {Command} from '../src/index.js'

type Favorite = {
  id: string;
  resource_id: string;
  resource_name: string;
  type: string;
}

type Favorites = Favorite[]

class FavoritesCommand extends Command {
  async run() {
    const {body: favorites} = await this.heroku.get<Favorites>(
      '/favorites?type=app',
      {hostname: 'particleboard.heroku.com'},
    )

    ux.stdout('Favorited Apps')
    ux.stdout('')
    for (const f of favorites) {
      ux.stdout(f.resource_name)
    }
  }
}

(FavoritesCommand.run([]) as any)
  .catch(require('@oclif/core').Errors.handle)

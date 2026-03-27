import {handle} from '@oclif/core/errors'
import {ux} from '@oclif/core/ux'

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

try {
  await FavoritesCommand.run([])
} catch (error: unknown) {
  handle(error as Error)
}

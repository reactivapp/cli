import {AppInit} from './commands/app/init'
import {AppRun} from './commands/app/run'
import {AppSubmit} from './commands/app/submit'
import {AppUpgrade} from './commands/app/upgrade'
import {Login} from './commands/login'
import {Logout} from './commands/logout'
import {Whoami} from './commands/whoami'

export const COMMANDS = {
  'app:init': AppInit,
  'app:run': AppRun,
  'app:submit': AppSubmit,
  'app:upgrade': AppUpgrade,
  login: Login,
  logout: Logout,
  whoami: Whoami,
}

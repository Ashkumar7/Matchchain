const axios = require('axios');
const https = require('https');
const { parse } = require('querystring');
const { execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const colors = require('colors');
const { DateTime } = require('luxon');

const httpsAgent = new https.Agent({
  rejectUnauthorized: false,
});

const headers = {
  host: 'tgapp-api.matchain.io',
  connection: 'keep-alive',
  accept: 'application/json, text/plain, */*',
  'user-agent':
    'Mozilla/5.0 (Linux; Android 10; Redmi 4A / 5A Build/QQ3A.200805.001; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/86.0.4240.185 Mobile Safari/537.36',
  'content-type': 'application/json',
  origin: 'https://tgapp.matchain.io',
  'x-requested-with': 'tw.nekomimi.nekogram',
  'sec-fetch-site': 'same-site',
  'sec-fetch-mode': 'cors',
  'sec-fetch-dest': 'empty',
  referer: 'https://tgapp.matchain.io/',
  'accept-language': 'en,en-US;q=0.9',
};

class Matchain {
  constructor() {
    this.headers = { ...headers };
    this.autogame = true;
  }

  async http(url, headers, data = null) {
    const config = {
      headers,
      httpsAgent,
    };
    while (true) {
      try {
        const res = data ? await axios.post(url, data, config) : await axios.get(url, config);
        return res;
      } catch (error) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
  }

  log(msg, level = 'info') {
    const levels = {
      info: 'cyan',
      success: 'green',
      warning: 'yellow',
      error: 'red',
    };
    console.log(`[*] ${msg}`[levels[level]]);
  }

  parseData(data) {
    const params = new URLSearchParams(data);
    const parsedData = {};
    for (const [key, value] of params.entries()) {
      parsedData[key] = value;
    }
    return parsedData;
  }

  async completeQuiz() {
    try {
      const quizUrl = 'https://tgapp-api.matchain.io/api/tgapp/v1/daily/quiz/progress';
      let quizRes = await this.http(quizUrl, this.headers);
      if (quizRes.status !== 200) {
        this.log('Error fetching quiz questions!', 'error');
        return false;
      }

      const quizData = quizRes.data.data;
      const answerResult = [];

      for (const question of quizData) {
        const correctAnswer = question.items.find((item) => item.is_correct);
        if (correctAnswer) {
          answerResult.push({
            quiz_id: question.Id,
            selected_item: correctAnswer.number,
            correct_item: correctAnswer.number,
          });
        }
      }

      const submitUrl = 'https://tgapp-api.matchain.io/api/tgapp/v1/daily/quiz/submit';
      const payload = JSON.stringify({ answer_result: answerResult });
      let submitRes = await this.http(submitUrl, this.headers, payload);

      if (submitRes.status === 200 && submitRes.data.code === 200) {
        this.log('Successfully answered quiz questions!', 'success');
        return true;
      } else {
        this.log('Error submitting quiz answers!', 'error');
        return false;
      }
    } catch (error) {
      this.log('You have already answered the quiz today!', 'error');
      return false;
    }
  }

  async login(data) {
    const parser = this.parseData(data);
    const userEncoded = decodeURIComponent(parser['user']);
    let user;
    try {
      user = JSON.parse(userEncoded);
    } catch (error) {
      this.log('Unable to parse JSON', 'error');
      return false;
    }

    const url = 'https://tgapp-api.matchain.io/api/tgapp/v1/user/login';
    const payload = JSON.stringify({
      uid: user['id'],
      first_name: user['first_name'],
      last_name: user['last_name'],
      username: user['username'],
      tg_login_params: data,
    });

    let res = await this.http(url, this.headers, payload);
    if (res.status !== 200) {
      this.log(`Login failed! Status: ${res.status}`, 'error');
      return false;
    }

    if (!res.data || !res.data.data || !res.data.data.token) {
      this.log('Token not found!', 'error');
      return false;
    }

    this.userid = user['id'];
    this.log('Login successful!', 'success');
    const token = res.data.data.token;
    this.headers['authorization'] = token;

    const balanceUrl = 'https://tgapp-api.matchain.io/api/tgapp/v1/point/balance';
    res = await this.http(balanceUrl, this.headers, JSON.stringify({ uid: this.userid }));
    if (res.status !== 200) {
      this.log('Error fetching balance!', 'error');
      return false;
    }

    const balance = res.data.data;
    this.log(`Balance: ${balance / 1000}`, 'info');

    const quizResult = await this.completeQuiz();
    if (quizResult) {
      this.log('Completed daily quiz', 'success');
    } else {
      this.log('Unable to complete daily quiz', 'warning');
    }

    const taskStatus = await this.checkDailyTaskStatus();
    if (taskStatus) {
      if (taskStatus.dailyNeedsPurchase) {
        try {
          const boosterResult = await this.buyBooster(token, this.userid);
          if (boosterResult.code === 400) {
            this.log('You have already purchased a booster, try again later!', 'warning');
          } else if (boosterResult) {
            this.log('Successfully purchased Daily Booster', 'success');
          }
        } catch (error) {
          console.error('Error buying booster:', error);
          this.log('Error purchasing Daily Booster', 'error');
        }
      }
    }

    let next_claim = 0;
    while (true) {
      const rewardUrl = 'https://tgapp-api.matchain.io/api/tgapp/v1/point/reward';
      res = await this.http(rewardUrl, this.headers, JSON.stringify({ uid: this.userid }));
      if (res.status !== 200) {
        this.log('Error, check response!', 'error');
        return false;
      }

      next_claim = res.data.data.next_claim_timestamp;
      if (next_claim === 0) {
        const farmingUrl = 'https://tgapp-api.matchain.io/api/tgapp/v1/point/reward/farming';
        res = await this.http(farmingUrl, this.headers, JSON.stringify({ uid: this.userid }));
        if (res.status !== 200) {
          this.log('Error, check response!', 'error');
          return false;
        }
        continue;
      }

      if (next_claim > Date.now()) {
        const format_next_claim = DateTime.fromMillis(next_claim).toFormat('yyyy-MM-dd HH:mm:ss');
        this.log('Currently farming!', 'warning');
        this.log(`Farming completion time: ${format_next_claim}`, 'info');
        break;
      }

      const claimUrl = 'https://tgapp-api.matchain.io/api/tgapp/v1/point/reward/claim';
      res = await this.http(claimUrl, this.headers, JSON.stringify({ uid: this.userid }));
      if (res.status !== 200) {
        this.log('Failed to claim reward!', 'error');
        return false;
      }

      const _data = res.data.data;
      this.log('Reward successfully claimed', 'success');
      this.log(`Balance: ${balance + _data}`, 'info');
    }

    const taskNames = await this.getTaskList(user['id']);
    for (let taskType of taskNames) {
      await this.completeTask(user['id'], taskType);
    }

    const updatedTaskStatus = await this.checkDailyTaskStatus();
    if (updatedTaskStatus && updatedTaskStatus.gameNeedsPurchase) {
      const ticketResult = await this.buyTicket(token, this.userid);
      if (ticketResult) {
        this.log('Successfully purchased Game Ticket', 'success');
      }
    }

    const gameRuleUrl = 'https://tgapp-api.matchain.io/api/tgapp/v1/game/rule';
    let gameRuleRes = await this.http(gameRuleUrl, this.headers);
    if (gameRuleRes.status !== 200) {
      this.log('Error fetching game information!', 'error');
      return false;
    }

    let gameCount = gameRuleRes.data.data.game_count;
    this.log(`Remaining game plays: ${gameCount}`, 'info');

    const gameUrl = 'https://tgapp-api.matchain.io/api/tgapp/v1/game/play';
    while (gameCount > 0) {
      let res = await this.http(gameUrl, this.headers);
      if (res.status !== 200) {
        this.log('Error starting game!', 'error');
        return false;
      }

      const game_id = res.data.data.game_id;
      this.log(`Starting game ID: ${game_id}`, 'info');

      await this.countdown(30);
      const point = Math.floor(Math.random() * (150 - 100 + 1)) + 100;
      const payload = JSON.stringify({ game_id: game_id, point: point });
      const url_claim = 'https://tgapp-api.matchain.io/api/tgapp/v1/game/claim';
      res = await this.http(url_claim, this.headers, payload);
      if (res.status !== 200) {
        this.log('Unable to end game!', 'error');
        continue;
      }

      this.log(`Game completed, earned: ${point}`, 'success');
      gameCount--;
      this.log(`Remaining game plays: ${gameCount}`, 'info');
    }

    this.log('No more game plays!', 'warning');

    return Math.round(next_claim / 1000 - Date.now() / 1000) + 30;
  }

  load_data(file) {
    const data = fs
      .readFileSync(file, 'utf-8')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '');

    if (data.length === 0) {
      this.log('No accounts found!', 'warning');
      return false;
    }

    return data;
  }

  async getTaskList(uid) {
    const url = 'https://tgapp-api.matchain.io/api/tgapp/v1/point/task/list';
    const payload = JSON.stringify({ uid: uid });

    let res = await this.http(url, this.headers, payload);
    if (res.status !== 200) {
      this.log(`Error fetching task list! Status: ${res.status}`, 'error');
      return false;
    }

    const data = res.data.data;

    if (!data || !Array.isArray(data.Tasks)) {
      this.log('Invalid data', 'error');
      return false;
    }

    const extraTasks = Array.isArray(data['Extra Tasks']) ? data['Extra Tasks'] : [];
    const allTasks = [...data.Tasks, ...extraTasks];
    const filteredTasks = allTasks.filter((task) => task.complete === false && task.name !== 'join_match_group');
    const taskNames = filteredTasks.map((task) => task.name);
    return taskNames;
  }

  async completeTask(uid, taskType) {
    const url = 'https://tgapp-api.matchain.io/api/tgapp/v1/point/task/complete';
    const payload = JSON.stringify({ uid: uid, type: taskType });

    let res = await this.http(url, this.headers, payload);
    if (res.status !== 200) {
      this.log(`Error completing task ${taskType}! Status: ${res.status}`, 'error');
      this.log(`Response: ${JSON.stringify(res.data)}`, 'error');
      return false;
    }

    const rewardClaimed = await this.claimReward(uid, taskType);
    return rewardClaimed;
  }

  async claimReward(uid, taskType) {
    const url = 'https://tgapp-api.matchain.io/api/tgapp/v1/point/task/claim';
    const payload = JSON.stringify({ uid: uid, type: taskType });

    let res = await this.http(url, this.headers, payload);
    if (res.status !== 200) {
      this.log(`Error claiming task reward ${taskType}! Status: ${res.status}`, 'error');
      this.log(`Response: ${JSON.stringify(res.data)}`, 'error');
      return false;
    }

    if (res.data.code === 200 && res.data.data === 'success') {
      this.log(`${'Task'.yellow} ${taskType.white} ... ${'Status:'.white} ${'Completed'.green}`);
    } else {
      this.log(`${'Task'.yellow} ${taskType.white} ... ${'Status:'.white} ${'Failed'.red}`);
      this.log(`Response: ${JSON.stringify(res.data)}`, 'error');
      return false;
    }

    return true;
  }

  async buyTicket(token, userId) {
    const url = 'https://tgapp-api.matchain.io/api/tgapp/v1/daily/task/purchase';
    const headers = {
      ...this.headers,
      Authorization: token,
    };
    const payload = {
      uid: userId,
      type: 'game',
    };

    try {
      const response = await this.http(url, headers, JSON.stringify(payload));
      return response.data;
    } catch (error) {
      if (error.response && error.response.status === 401) {
        this.log('JSON Decode Error: Token Invalid', 'error');
      } else {
        this.log(`Request Error: ${error.message}`, 'error');
      }
      return null;
    }
  }

  async buyBooster(token, userId) {
    const url = 'https://tgapp-api.matchain.io/api/tgapp/v1/daily/task/purchase';
    const headers = {
      ...this.headers,
      Authorization: token,
    };
    const payload = {
      uid: userId,
      type: 'daily',
    };

    try {
      const response = await this.http(url, headers, JSON.stringify(payload));
      return response.data;
    } catch (error) {
      if (error.response && error.response.status === 401) {
        this.log('JSON Decode Error: Token Invalid', 'error');
      } else {
        this.log(`Request Error: ${error.message}`, 'error');
      }
      return null;
    }
  }

  async checkDailyTaskStatus() {
    const url = 'https://tgapp-api.matchain.io/api/tgapp/v1/daily/task/status';
    try {
      const response = await this.http(url, this.headers);
      if (response.status !== 200 || !response.data || !response.data.data) {
        this.log('Error checking daily task status', 'error');
        return null;
      }

      const taskData = response.data.data;
      const dailyTask = taskData.find((task) => task.type === 'daily');
      const gameTask = taskData.find((task) => task.type === 'game');

      return {
        dailyNeedsPurchase: dailyTask && dailyTask.current_count < dailyTask.task_count,
        gameNeedsPurchase: gameTask && gameTask.current_count < gameTask.task_count,
      };
    } catch (error) {
      this.log(`Error checking task status: ${error.message}`, 'error');
      return null;
    }
  }

  async main() {
    const args = require('minimist')(process.argv.slice(2));
    if (!args['--marin']) {
      if (os.platform() === 'win32') {
        execSync('cls', { stdio: 'inherit' });
      } else {
        execSync('clear', { stdio: 'inherit' });
      }
    }
    this.autogame = true;

    while (true) {
      const list_countdown = [];
      const start = Math.floor(Date.now() / 1000);
      const data = this.load_data(args['--data'] || 'data.txt');
      for (let [no, item] of data.entries()) {
        const parser = this.parseData(item);
        const userEncoded = decodeURIComponent(parser['user']);
        let user;
        try {
          user = JSON.parse(userEncoded);
        } catch (error) {
          this.log('Unable to parse JSON', 'error');
          continue;
        }
        console.log(`========== Account ${no + 1} | ${user['first_name'].green} ==========`);
        const result = await this.login(item);
        if (result) {
          list_countdown.push(result);
          await this.countdown(3);
        }
      }

      const end = Math.floor(Date.now() / 1000);
      const total = end - start;
      const min = Math.min(...list_countdown) - total;
      if (min <= 0) {
        continue;
      }

      await this.countdown(min);
    }
  }

  async countdown(t) {
    while (t) {
      const hours = String(Math.floor(t / 3600)).padStart(2, '0');
      const minutes = String(Math.floor((t % 3600) / 60)).padStart(2, '0');
      const seconds = String(t % 60).padStart(2, '0');
      process.stdout.write(`[*] Waiting ${hours}:${minutes}:${seconds}     \r`.gray);
      await new Promise((resolve) => setTimeout(resolve, 1000));
      t -= 1;
    }
    process.stdout.write('\r');
  }
}

if (require.main === module) {
  const app = new Matchain();
  app.main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

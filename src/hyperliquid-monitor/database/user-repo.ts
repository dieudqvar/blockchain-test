import * as fs from 'fs';
import * as path from 'path';

export interface UserDevice {
  userId: string;
  walletAddress: string;
  deviceTokens: string[];
}

export class UserRepo {
  async getAllMonitoredUsers(): Promise<UserDevice[]> {
    const filePath = path.resolve(__dirname, '..', 'tempo.json');
    const addresses: string[] = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return addresses.map((addr) => ({
      userId: addr.toLowerCase(),
      walletAddress: addr,
      deviceTokens: [],
    }));
  }

  async getDeviceTokensByWallet(_walletAddress: string): Promise<string[]> {
    return [];
  }
}

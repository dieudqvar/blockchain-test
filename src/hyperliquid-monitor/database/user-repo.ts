export interface UserDevice {
  userId: string;
  walletAddress: string;
  deviceTokens: string[];
}

const FAKE_USERS: UserDevice[] = [
  {
    userId: 'user-001',
    walletAddress: '0x010b2b2090d4ee5d5a0a8c4b0c30e4f2d1e3b4a5',
    deviceTokens: ['fake-device-token-001'],
  },
  {
    userId: 'user-002',
    walletAddress: '0x020c3c3191e5ff6e6b1b9d5c1d41f5g3e2f4c5b6',
    deviceTokens: ['fake-device-token-002a', 'fake-device-token-002b'],
  },
];

export class UserRepo {
  async getAllMonitoredUsers(): Promise<UserDevice[]> {
    return FAKE_USERS;
  }

  async getDeviceTokensByWallet(walletAddress: string): Promise<string[]> {
    return (
      FAKE_USERS.find((u) => u.walletAddress === walletAddress)?.deviceTokens ??
      []
    );
  }
}

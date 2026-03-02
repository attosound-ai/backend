import { ConfigService } from "@nestjs/config";

// Shared mock fns — declared inside the jest.mock factory to avoid hoisting issues
const mockList = jest.fn();
const mockCreate = jest.fn();
const mockRemove = jest.fn();
const mockUpdate = jest.fn();

jest.mock("twilio", () => {
  // The factory runs *after* the above declarations thanks to jest hoisting
  // BUT the references inside are evaluated lazily (closures), so this works
  // only if we use the __esModule trick or default export pattern.
  const mockClient = {
    availablePhoneNumbers: jest.fn().mockReturnValue({
      local: {
        list: (...args: unknown[]) => mockList(...args),
      },
    }),
    incomingPhoneNumbers: Object.assign(
      jest.fn().mockImplementation(() => ({
        remove: (...args: unknown[]) => mockRemove(...args),
        update: (...args: unknown[]) => mockUpdate(...args),
      })),
      {
        create: (...args: unknown[]) => mockCreate(...args),
      },
    ),
  };
  const factory = jest.fn().mockReturnValue(mockClient);
  return { __esModule: true, default: factory };
});

// Import AFTER mocking
import { TwilioNumberService } from "./twilio-number.service";

describe("TwilioNumberService", () => {
  let service: TwilioNumberService;

  beforeEach(() => {
    jest.clearAllMocks();

    const configService = {
      get: jest.fn((key: string, fallback?: string) => {
        const map: Record<string, string> = {
          "twilio.accountSid": "ACtest123",
          "twilio.authToken": "test-token",
        };
        return map[key] ?? fallback ?? "";
      }),
    } as unknown as ConfigService;

    service = new TwilioNumberService(configService);
  });

  describe("searchAvailable", () => {
    it("should return available numbers", async () => {
      mockList.mockResolvedValue([
        {
          phoneNumber: "+15005550006",
          friendlyName: "(500) 555-0006",
          locality: "Test City",
          region: "CA",
        },
      ]);

      const result = await service.searchAvailable("US", {
        areaCode: "500",
        limit: 1,
      });

      expect(result).toEqual([
        {
          phoneNumber: "+15005550006",
          friendlyName: "(500) 555-0006",
          locality: "Test City",
          region: "CA",
        },
      ]);
      expect(mockList).toHaveBeenCalledWith({
        voiceEnabled: true,
        limit: 1,
        areaCode: "500",
      });
    });

    it("should return empty array when none available", async () => {
      mockList.mockResolvedValue([]);

      const result = await service.searchAvailable("US");

      expect(result).toEqual([]);
    });
  });

  describe("provision", () => {
    it("should purchase a number and return provisioned details", async () => {
      mockCreate.mockResolvedValue({
        sid: "PNtest123",
        phoneNumber: "+15005550006",
        friendlyName: "(500) 555-0006",
      });

      const result = await service.provision(
        "+15005550006",
        "https://example.com/voice",
        "https://example.com/status",
      );

      expect(result).toEqual({
        twilioNumberSid: "PNtest123",
        phoneNumber: "+15005550006",
        friendlyName: "(500) 555-0006",
      });
      expect(mockCreate).toHaveBeenCalledWith({
        phoneNumber: "+15005550006",
        voiceUrl: "https://example.com/voice",
        voiceMethod: "POST",
        statusCallback: "https://example.com/status",
        statusCallbackMethod: "POST",
      });
    });

    it("should propagate Twilio errors", async () => {
      mockCreate.mockRejectedValue(new Error("Purchase failed"));

      await expect(
        service.provision(
          "+15005550006",
          "https://example.com/voice",
          "https://example.com/status",
        ),
      ).rejects.toThrow("Purchase failed");
    });
  });

  describe("release", () => {
    it("should remove the number from Twilio", async () => {
      mockRemove.mockResolvedValue(undefined);

      await service.release("PNtest123");

      expect(mockRemove).toHaveBeenCalled();
    });
  });

  describe("updateWebhook", () => {
    it("should update the voice URL", async () => {
      mockUpdate.mockResolvedValue({});

      await service.updateWebhook(
        "PNtest123",
        "https://new.example.com/voice",
      );

      expect(mockUpdate).toHaveBeenCalledWith({
        voiceUrl: "https://new.example.com/voice",
        voiceMethod: "POST",
      });
    });
  });
});

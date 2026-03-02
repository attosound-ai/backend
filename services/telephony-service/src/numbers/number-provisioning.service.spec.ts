import { NumberProvisioningService } from "./number-provisioning.service";
import { TwilioNumberService } from "./twilio-number.service";
import { KafkaProducer } from "../kafka/kafka.producer";
import { ConfigService } from "@nestjs/config";
import { Repository } from "typeorm";
import { ProvisionedNumber } from "../entities/provisioned-number.entity";
import { PhoneNumberAssignment } from "../entities/phone-number-assignment.entity";

describe("NumberProvisioningService", () => {
  let service: NumberProvisioningService;
  let numberRepo: jest.Mocked<Repository<ProvisionedNumber>>;
  let assignmentRepo: jest.Mocked<Repository<PhoneNumberAssignment>>;
  let twilioNumbers: jest.Mocked<TwilioNumberService>;
  let kafka: jest.Mocked<KafkaProducer>;
  let config: jest.Mocked<ConfigService>;

  beforeEach(() => {
    numberRepo = {
      findOne: jest.fn(),
      save: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    } as unknown as jest.Mocked<Repository<ProvisionedNumber>>;

    assignmentRepo = {
      findOne: jest.fn(),
      save: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    } as unknown as jest.Mocked<Repository<PhoneNumberAssignment>>;

    twilioNumbers = {
      searchAvailable: jest.fn(),
      provision: jest.fn(),
      release: jest.fn(),
      updateWebhook: jest.fn(),
    } as unknown as jest.Mocked<TwilioNumberService>;

    kafka = {
      publish: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<KafkaProducer>;

    config = {
      get: jest.fn().mockReturnValue("http://localhost:3009"),
    } as unknown as jest.Mocked<ConfigService>;

    service = new NumberProvisioningService(
      numberRepo,
      assignmentRepo,
      twilioNumbers,
      kafka,
      config,
    );
  });

  describe("assignNumberToUser", () => {
    const userId = "user-123";
    const subscriptionId = "sub-456";

    it("should return existing number if already assigned (idempotent)", async () => {
      const existing = {
        phoneNumber: "+15005550006",
        userId,
        status: "assigned",
      } as ProvisionedNumber;

      numberRepo.findOne.mockResolvedValueOnce(existing);

      const result = await service.assignNumberToUser(userId, subscriptionId);

      expect(result).toBe("+15005550006");
      expect(twilioNumbers.searchAvailable).not.toHaveBeenCalled();
      expect(kafka.publish).not.toHaveBeenCalled();
    });

    it("should reuse a number from the pool when available", async () => {
      // No existing assignment
      numberRepo.findOne.mockResolvedValueOnce(null);
      // Available number in pool
      const pooled = {
        id: "pn-1",
        phoneNumber: "+15005550006",
        twilioNumberSid: "PNtest123",
        status: "available",
        userId: null,
      } as unknown as ProvisionedNumber;
      numberRepo.findOne.mockResolvedValueOnce(pooled);
      numberRepo.save.mockResolvedValue(pooled);

      // Assignment repo — no existing assignment
      assignmentRepo.findOne.mockResolvedValue(null);
      assignmentRepo.create.mockReturnValue({
        phoneNumber: "+15005550006",
        userId,
        subscriptionId,
        status: "active",
      } as unknown as PhoneNumberAssignment);
      assignmentRepo.save.mockResolvedValue({} as PhoneNumberAssignment);

      const result = await service.assignNumberToUser(userId, subscriptionId);

      expect(result).toBe("+15005550006");
      expect(numberRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          userId,
          subscriptionId,
          status: "assigned",
        }),
      );
      expect(kafka.publish).toHaveBeenCalledWith(
        "number.provisioned",
        expect.objectContaining({ userId, phoneNumber: "+15005550006" }),
      );
      // Should NOT have called Twilio to buy a new number
      expect(twilioNumbers.searchAvailable).not.toHaveBeenCalled();
    });

    it("should purchase a new number when pool is empty", async () => {
      // No existing assignment
      numberRepo.findOne.mockResolvedValueOnce(null);
      // No available numbers in pool
      numberRepo.findOne.mockResolvedValueOnce(null);

      // Twilio search + provision
      twilioNumbers.searchAvailable.mockResolvedValue([
        {
          phoneNumber: "+15005550006",
          friendlyName: "(500) 555-0006",
          locality: "Test",
          region: "CA",
        },
      ]);
      twilioNumbers.provision.mockResolvedValue({
        twilioNumberSid: "PNnew789",
        phoneNumber: "+15005550006",
        friendlyName: "(500) 555-0006",
      });

      const newNumber = {
        id: "pn-new",
        twilioNumberSid: "PNnew789",
        phoneNumber: "+15005550006",
        status: "available",
        userId: null,
      } as unknown as ProvisionedNumber;
      numberRepo.create.mockReturnValue(newNumber);
      numberRepo.save.mockResolvedValue(newNumber);

      assignmentRepo.findOne.mockResolvedValue(null);
      assignmentRepo.create.mockReturnValue({
        phoneNumber: "+15005550006",
        userId,
        subscriptionId,
        status: "active",
      } as unknown as PhoneNumberAssignment);
      assignmentRepo.save.mockResolvedValue({} as PhoneNumberAssignment);

      const result = await service.assignNumberToUser(userId, subscriptionId);

      expect(result).toBe("+15005550006");
      expect(twilioNumbers.searchAvailable).toHaveBeenCalledWith("US", {
        limit: 1,
      });
      expect(twilioNumbers.provision).toHaveBeenCalled();
      expect(kafka.publish).toHaveBeenCalledWith(
        "number.provisioned",
        expect.objectContaining({ userId, phoneNumber: "+15005550006" }),
      );
    });

    it("should throw when no numbers available from Twilio", async () => {
      numberRepo.findOne.mockResolvedValueOnce(null);
      numberRepo.findOne.mockResolvedValueOnce(null);
      twilioNumbers.searchAvailable.mockResolvedValue([]);

      await expect(
        service.assignNumberToUser(userId, subscriptionId),
      ).rejects.toThrow("No phone numbers available for provisioning");
    });
  });

  describe("releaseNumber", () => {
    it("should return number to pool on cancellation", async () => {
      const assigned = {
        id: "pn-1",
        phoneNumber: "+15005550006",
        userId: "user-123",
        status: "assigned",
      } as unknown as ProvisionedNumber;

      numberRepo.findOne.mockResolvedValue(assigned);
      numberRepo.save.mockResolvedValue(assigned);
      assignmentRepo.update.mockResolvedValue({} as any);

      await service.releaseNumber("user-123");

      expect(numberRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          status: "available",
          userId: null,
          subscriptionId: null,
        }),
      );
      expect(assignmentRepo.update).toHaveBeenCalledWith(
        { phoneNumber: "+15005550006" },
        { status: "inactive" },
      );
      expect(kafka.publish).toHaveBeenCalledWith(
        "number.released",
        expect.objectContaining({
          userId: "user-123",
          phoneNumber: "+15005550006",
        }),
      );
    });

    it("should do nothing if no assigned number found", async () => {
      numberRepo.findOne.mockResolvedValue(null);

      await service.releaseNumber("user-999");

      expect(numberRepo.save).not.toHaveBeenCalled();
      expect(kafka.publish).not.toHaveBeenCalled();
    });
  });

  describe("deleteNumber", () => {
    it("should fully remove from Twilio and DB", async () => {
      twilioNumbers.release.mockResolvedValue(undefined);
      numberRepo.update.mockResolvedValue({} as any);
      numberRepo.delete.mockResolvedValue({} as any);

      await service.deleteNumber("PNtest123");

      expect(twilioNumbers.release).toHaveBeenCalledWith("PNtest123");
      expect(numberRepo.delete).toHaveBeenCalledWith({
        twilioNumberSid: "PNtest123",
      });
    });
  });
});

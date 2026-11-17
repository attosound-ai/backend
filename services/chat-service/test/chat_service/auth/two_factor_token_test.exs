defmodule ChatService.Auth.TwoFactorTokenTest do
  use ExUnit.Case, async: true

  alias ChatService.Auth.JWT

  # Nov 12 2026: the 2FA temporary token (password only, before the second
  # factor) is signed with the shared secret. Chat already pins the issuer,
  # so it never accepted it; this keeps it that way.
  defp sign(claims) do
    secret = Application.fetch_env!(:chat_service, ChatService.Auth.JWT)[:secret]
    signer = Joken.Signer.create("HS256", secret)
    now = System.system_time(:second)
    {:ok, token, _} = Joken.encode_and_sign(Map.merge(%{"iat" => now, "exp" => now + 300}, claims), signer)
    token
  end

  test "both 2FA token shapes are refused" do
    assert {:error, _} = JWT.verify_user_token(sign(%{"sub" => "281", "iss" => "atto-sound-2fa"}))

    assert {:error, _} =
             JWT.verify_user_token(
               sign(%{"sub" => "2fa:281", "iss" => "atto-sound-2fa", "scope" => "2fa_pending"})
             )
  end

  test "a 2fa_pending scope is refused even with the session issuer" do
    assert {:error, _} =
             JWT.verify_user_token(
               sign(%{"sub" => "281", "iss" => "atto-sound-user-service", "scope" => "2fa_pending"})
             )
  end

  test "a session token still works" do
    assert {:ok, "281"} =
             JWT.verify_user_token(sign(%{"sub" => "281", "iss" => "atto-sound-user-service", "scope" => "user"}))
  end
end

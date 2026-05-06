defmodule ChatService.Auth.JWTTest do
  use ExUnit.Case, async: true

  alias ChatService.Auth.JWT

  @secret Application.compile_env!(:chat_service, ChatService.Auth.JWT)[:secret]
  @issuer "atto-sound-user-service"

  defp signer, do: Joken.Signer.create("HS256", @secret)

  defp token(claims, opts \\ []) do
    signer = Keyword.get(opts, :signer, signer())
    {:ok, jwt, _claims} = Joken.encode_and_sign(claims, signer)
    jwt
  end

  defp now, do: System.system_time(:second)

  describe "verify_user_token/1" do
    test "returns the user_id for a valid HS256 token with sub claim" do
      jwt = token(%{"sub" => "166", "iss" => @issuer, "exp" => now() + 3600})
      assert {:ok, "166"} = JWT.verify_user_token(jwt)
    end

    test "coerces an integer sub to a string" do
      jwt = token(%{"sub" => 166, "iss" => @issuer, "exp" => now() + 3600})
      assert {:ok, "166"} = JWT.verify_user_token(jwt)
    end

    test "falls back to the user_id claim when sub is absent" do
      jwt = token(%{"user_id" => "166", "iss" => @issuer, "exp" => now() + 3600})
      assert {:ok, "166"} = JWT.verify_user_token(jwt)
    end

    test "rejects an expired token" do
      jwt = token(%{"sub" => "166", "iss" => @issuer, "exp" => now() - 1})
      assert {:error, :invalid_token} = JWT.verify_user_token(jwt)
    end

    test "rejects a token signed with the wrong secret" do
      bad_signer = Joken.Signer.create("HS256", "different-secret")
      jwt = token(%{"sub" => "166", "iss" => @issuer, "exp" => now() + 3600}, signer: bad_signer)
      assert {:error, :invalid_token} = JWT.verify_user_token(jwt)
    end

    test "rejects a token whose issuer does not match" do
      jwt = token(%{"sub" => "166", "iss" => "evil-service", "exp" => now() + 3600})
      assert {:error, :invalid_token} = JWT.verify_user_token(jwt)
    end

    test "rejects a token with no subject claim" do
      jwt = token(%{"iss" => @issuer, "exp" => now() + 3600})
      assert {:error, :missing_subject} = JWT.verify_user_token(jwt)
    end

    test "rejects an empty string" do
      assert {:error, :missing_token} = JWT.verify_user_token("")
    end

    test "rejects nil" do
      assert {:error, :missing_token} = JWT.verify_user_token(nil)
    end

    test "rejects a malformed token" do
      assert {:error, :invalid_token} = JWT.verify_user_token("not.a.jwt")
    end

    test "rejects a token whose alg header is not HS256 (algorithm confusion)" do
      # Manually craft a token with alg=none and no signature.
      header = %{"alg" => "none", "typ" => "JWT"} |> Jason.encode!() |> Base.url_encode64(padding: false)

      payload =
        %{"sub" => "166", "iss" => @issuer, "exp" => now() + 3600}
        |> Jason.encode!()
        |> Base.url_encode64(padding: false)

      forged = "#{header}.#{payload}."

      assert {:error, :invalid_token} = JWT.verify_user_token(forged)
    end
  end
end

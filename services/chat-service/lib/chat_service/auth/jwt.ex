defmodule ChatService.Auth.JWT do
  @moduledoc """
  HS256 JWT verification shared by HTTP and WebSocket authentication.

  Tokens are issued by the Go user-service and signed with the
  `JWT_SECRET` environment variable shared across all microservices.

  Security notes:

  * The signer algorithm is **pinned to HS256**. Tokens whose `alg` header is
    anything else (including `none`) are rejected. This blocks classical
    algorithm-confusion attacks.
  * Standard temporal claims (`exp`, `iat`, `nbf`) are validated by the
    Joken default-claims pipeline.
  * The `iss` claim is pinned to `"atto-sound-user-service"` to prevent
    cross-service token reuse.
  * The function returns `{:ok, user_id}` only when a non-empty `sub`
    (string or integer) is present in the verified claims.
  """

  use Joken.Config, default_signer: nil

  @issuer "atto-sound-user-service"

  @impl Joken.Config
  def token_config do
    default_claims(skip: [:aud, :jti])
    |> add_claim("iss", nil, &(&1 == @issuer))
  end

  @doc """
  Verifies an HS256 JWT and returns `{:ok, user_id_string}` on success.

  Failure modes (all returned as `{:error, reason}`):

  * `:missing_token` — empty or non-binary input
  * `:invalid_token` — signature mismatch, `alg` mismatch, expired,
    issuer mismatch, or any other claim-validation failure
  * `:missing_subject` — token verified but no `sub` / `user_id` claim
  """
  @spec verify_user_token(any()) ::
          {:ok, String.t()} | {:error, :missing_token | :invalid_token | :missing_subject}
  def verify_user_token(token) when is_binary(token) and byte_size(token) > 0 do
    case verify_and_validate(token, signer()) do
      {:ok, claims} -> extract_user_id(claims)
      {:error, _reason} -> {:error, :invalid_token}
    end
  end

  def verify_user_token(_), do: {:error, :missing_token}

  defp signer do
    Joken.Signer.create("HS256", secret())
  end

  defp secret do
    case Application.fetch_env(:chat_service, __MODULE__) do
      {:ok, opts} ->
        case Keyword.get(opts, :secret) do
          s when is_binary(s) and byte_size(s) > 0 -> s
          _ -> raise "JWT secret not configured for #{inspect(__MODULE__)}"
        end

      :error ->
        raise "JWT secret not configured for #{inspect(__MODULE__)}"
    end
  end

  defp extract_user_id(%{"sub" => sub}) when is_binary(sub) and sub != "", do: {:ok, sub}
  defp extract_user_id(%{"sub" => sub}) when is_integer(sub), do: {:ok, Integer.to_string(sub)}

  defp extract_user_id(%{"user_id" => uid}) when is_binary(uid) and uid != "", do: {:ok, uid}
  defp extract_user_id(%{"user_id" => uid}) when is_integer(uid), do: {:ok, Integer.to_string(uid)}

  defp extract_user_id(_), do: {:error, :missing_subject}
end

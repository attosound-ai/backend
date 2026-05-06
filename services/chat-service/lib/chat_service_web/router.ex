defmodule ChatServiceWeb.Router do
  use Phoenix.Router

  import Plug.Conn
  import Phoenix.Controller

  pipeline :api do
    plug :accepts, ["json"]
  end

  pipeline :authenticated do
    plug ChatServiceWeb.Plugs.AuthenticateUser
  end

  scope "/api/v1", ChatServiceWeb do
    pipe_through [:api, :authenticated]

    get "/messages/conversations", ConversationController, :index
    post "/messages/conversations", ConversationController, :create
    get "/messages/:chat_id", MessageController, :index
    post "/messages/:chat_id/read", MessageController, :mark_read
    patch "/messages/:chat_id/:message_id", MessageController, :update
    delete "/messages/:chat_id/:message_id", MessageController, :delete
    post "/messages", MessageController, :create

    # Reactions
    get "/messages/:chat_id/:message_id/reactions", ReactionController, :index
    post "/messages/:chat_id/:message_id/reactions", ReactionController, :create
    delete "/messages/:chat_id/:message_id/reactions/:emoji", ReactionController, :delete
  end

  scope "/", ChatServiceWeb do
    get "/health", HealthController, :index
  end

  # Enable LiveDashboard in development
  if Application.compile_env(:chat_service, :dev_routes, false) do
    import Phoenix.LiveDashboard.Router

    scope "/dev" do
      pipe_through [:fetch_session, :protect_from_forgery]
      live_dashboard "/dashboard", metrics: ChatServiceWeb.Telemetry
    end
  end
end

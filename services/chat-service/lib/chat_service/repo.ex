defmodule ChatService.Repo do
  @moduledoc """
  Xandra connection pool for Cassandra.

  This module is registered as a named Xandra.Cluster process in the supervisor tree.
  The keyspace is set at the cluster level, so individual queries don't need USE statements.
  """

  @cluster ChatService.Repo

  @doc """
  Execute a prepared CQL query with parameters.
  """
  def execute_prepared(query, params, opts \\ []) do
    with {:ok, prepared} <- Xandra.Cluster.prepare(@cluster, query) do
      Xandra.Cluster.execute(@cluster, prepared, params, opts)
    end
  end

  @doc """
  Execute a simple (non-prepared) CQL query.
  Useful for DDL statements and simple queries without parameters.
  """
  def execute_simple(query, opts \\ []) do
    Xandra.Cluster.execute(@cluster, query, opts)
  end
end

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
    clean_params = strip_type_annotations(params)

    with {:ok, prepared} <- Xandra.Cluster.prepare(@cluster, query) do
      Xandra.Cluster.execute(@cluster, prepared, clean_params, opts)
    end
  end

  # CQL reserved words that Xandra wraps in brackets for named params.
  @reserved_names ~w(limit)

  # Xandra prepared statements infer types from the prepared metadata,
  # so we strip the {"type", value} tuples and bracket reserved names.
  defp strip_type_annotations(params) when is_map(params) do
    Map.new(params, fn
      {key, {_type, value}} -> {normalize_key(key), value}
      {key, value} -> {normalize_key(key), value}
    end)
  end

  defp normalize_key(key) when key in @reserved_names, do: "[#{key}]"
  defp normalize_key(key), do: key

  defp strip_type_annotations(params), do: params

  @doc """
  Execute a simple (non-prepared) CQL query.
  Useful for DDL statements and simple queries without parameters.
  """
  def execute_simple(query, opts \\ []) do
    Xandra.Cluster.execute(@cluster, query, opts)
  end
end
